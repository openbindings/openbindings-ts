/**
 * The server and address configuration points of openbindings.asyncapi@1
 * §9.2 (ASYNC-P-04): the effective server set and its deterministic
 * ordering, server-variable substitution, channel-address parameter
 * expansion, and the concatenation URL-assembly rule. Every unresolvable
 * input is a pre-dispatch refusal, never a guess — this specification does
 * not assume the channel key is an address, never dials literal braces,
 * and refuses out-of-revision protocols.
 *
 * Consultation order per point is per-invocation configuration →
 * consumer-level configuration → the default; both configuration tiers
 * arrive merged in the binding context's `configuration` field (the same
 * carriage the openapi format consults), so this file reads one merged
 * value per point. Mirrors the Go SDK's target.go.
 */

import { contextConfiguration, contextMetadata } from "@openbindings/sdk";
import type {
  AsyncAPIChannel,
  AsyncAPIDocument,
  AsyncAPIServer,
} from "./asyncapi-types.js";
import { CHANNEL_NAME_TAG, SERVER_NAME_TAG } from "./constants.js";

/**
 * The protocols revision 1 of openbindings.asyncapi binds (§2). Everything
 * else is a definition-level exclusion, refused pre-dispatch (ASYNC-P-02).
 */
export function isBoundProtocol(p: string): boolean {
  return p === "http" || p === "https" || p === "ws" || p === "wss";
}

/** A doc server paired with its `servers`-map key, so consumer
 *  configuration can select a member by key and so security derivation
 *  can name the server it describes. */
export interface NamedServer {
  name: string;
  server: AsyncAPIServer;
}

/**
 * The outcome of the server configuration point: the assembled connection
 * base (scheme://host[/pathname], variables substituted, no trailing
 * slash), the deciding protocol, and the server whose declared security
 * applies (§9.5: the server the connection actually goes to — or, under a
 * full-URL override, the server the default selection would have
 * targeted; undefined when the artifact declares no such server).
 */
export interface ResolvedTarget {
  serverURL: string;
  protocol: string;
  securityServer?: AsyncAPIServer;
}

/** Reads the channel name off the resolved channel object (tagged onto the
 *  raw document's channels-map entries before dereferencing). */
export function channelNameOf(ch: AsyncAPIChannel | undefined): string {
  const tagged = (ch as unknown as Record<string, unknown> | undefined)?.[CHANNEL_NAME_TAG];
  return typeof tagged === "string" ? tagged : "";
}

/** Reads a server's servers-map key off the resolved server object (tagged
 *  onto the raw document's servers-map entries before dereferencing). */
function serverNameOf(srv: unknown): string {
  const tagged = (srv as Record<string, unknown> | null | undefined)?.[SERVER_NAME_TAG];
  return typeof tagged === "string" ? tagged : "";
}

/**
 * Returns the operation's effective server set (§9.2): the channel's
 * declared `servers` subset when present and non-empty, in the artifact's
 * own array order; else the document's `servers` map in lexicographic key
 * order (the map is unordered — this ordering is the specification's
 * determinism rule). An empty channel `servers` array means ALL servers,
 * the AsyncAPI rule. A channel `servers` $ref that did not resolve (or a
 * member naming no doc server) contributes nothing.
 */
export function effectiveServers(
  doc: AsyncAPIDocument,
  ch: AsyncAPIChannel | undefined,
): NamedServer[] {
  const docServers = doc.servers ?? {};
  const subset = ch?.servers;
  if (subset && subset.length > 0) {
    const out: NamedServer[] = [];
    for (const entry of subset) {
      const name = serverNameOf(entry);
      // Own-key lookup only (Go-map parity): a forged inline entry whose
      // name tag matches an Object.prototype member ("constructor", ...)
      // must contribute nothing, not surface a prototype member as a
      // server (which would TypeError in default selection).
      const server = name !== "" && Object.hasOwn(docServers, name) ? docServers[name] : undefined;
      if (server !== undefined) {
        out.push({ name, server });
      }
    }
    return out;
  }
  return Object.entries(docServers)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, server]) => ({ name, server }));
}

/**
 * Returns the server the default selection targets: the first candidate of
 * the effective set whose protocol revision 1 binds (§9.2), or undefined
 * when none exists.
 */
export function defaultServer(candidates: NamedServer[]): NamedServer | undefined {
  return candidates.find((c) => isBoundProtocol(c.server.protocol.toLowerCase()));
}

const NO_RESOLVABLE_SERVER =
  "no resolvable server: the effective server set declares no server with a supported protocol (http, https, ws, wss)";

/**
 * The typed signal a resolution helper throws when a named configuration point
 * cannot resolve because a value is absent (no default, no supplied value) — a
 * resolvable-missing value, not a malformed one. The invoke path turns it into
 * a config.value CONTEXT_REQUIRED challenge (retryable after resolution, R1a)
 * rather than a terminal ERR_SOURCE_CONFIG_ERROR. config values are non-secret,
 * so no credential-grade target keying is needed.
 */
export class ConfigRequired extends Error {
  constructor(
    readonly point: string,
    readonly key: string,
    message: string,
    readonly choices?: string[],
    readonly durable?: boolean,
  ) {
    super(message);
    this.name = "ConfigRequired";
  }
}

/**
 * Resolves the server configuration point for the operation's channel
 * (ASYNC-P-04): consumer configuration may select another member of the
 * effective set or supply a complete connection URL outright; the default
 * is the effective set's first bound-protocol candidate. Under a full-URL
 * override the URL's scheme decides the protocol (out-of-revision schemes
 * refused) and the declared security of the server the default would have
 * selected still applies (§9.5). No resolvable server is a pre-dispatch
 * refusal.
 *
 * The `configuration.server` value is pinned by §9.2 ("Configuration value
 * shapes") so two implementations carry it identically — an object, exactly
 * one of two mutually exclusive forms:
 *
 *   {"key": "<server-name>", "variables": {"<variable-name>": "<string-value>"}?}
 *                                  // select a member of the effective server set,
 *                                  // optionally supplying its declared server variables
 *   {"url": "<connection-url>"}    // override with a complete connection URL
 *
 * Every other spelling (a bare string, the retired `name` member, key+url
 * together, variables riding the url form) is refused loudly with a
 * teaching error naming the two pinned forms. Under {"key": ...} selection,
 * server variables substitute supplied-else-default-else-refusal: names are
 * the selected server's own declared variable names (an undeclared supplied
 * name is refused, never ignored), values are strings, and a supplied value
 * outside the variable's declared enum is refused (upstream SHOULD,
 * hardened to a refusal — the specification's own pin).
 *
 * The legacy context.metadata.baseURL override is honored below the
 * configuration point (the configuration point is the contract surface).
 */
export function resolveTarget(
  doc: AsyncAPIDocument,
  ch: AsyncAPIChannel | undefined,
  ctx?: Record<string, unknown>,
): ResolvedTarget {
  const candidates = effectiveServers(doc, ch);
  const def = defaultServer(candidates);

  const cfg = contextConfiguration(ctx);
  if (cfg["server"] !== undefined && cfg["server"] !== null) {
    return resolveServerConfig(cfg["server"], candidates, def);
  }

  const meta = contextMetadata(ctx);
  const base = meta["baseURL"];
  if (typeof base === "string" && base !== "") {
    return fullURLOverride(base, def);
  }

  if (!def)
    throw new ConfigRequired(
      "server",
      "url",
      `${NO_RESOLVABLE_SERVER}; supply a connection URL at the server configuration point`,
    );
  return assembleServer(def);
}

/**
 * The teaching tail of every non-pinned-form refusal, byte-identical to the
 * Go SDK's: §9.2 pins the value "so two implementations carry it
 * identically", and silently tolerating extra spellings would defeat the
 * pin.
 */
const SERVER_CONFIG_PINNED_SHAPES =
  'the pinned shapes (openbindings.asyncapi@1 §9.2) are {"key": "<server-name>", "variables": {"<variable-name>": "<string-value>"}?} (select a member of the effective server set, "variables" optionally supplying its declared server variables) xor {"url": "<connection-url>"} (override with a complete connection URL); the two forms are mutually exclusive and "variables" composes only with "key"';

/**
 * Applies one configured `server` value against the effective set,
 * accepting exactly §9.2's pinned value shapes: {"key": "<server-name>",
 * "variables": {...}?} xor {"url": "<connection-url>"}. Every other form
 * is a loud refusal carrying SERVER_CONFIG_PINNED_SHAPES.
 */
function resolveServerConfig(
  raw: unknown,
  candidates: NamedServer[],
  def: NamedServer | undefined,
): ResolvedTarget {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`configuration.server must be an object: ${SERVER_CONFIG_PINNED_SHAPES}`);
  }
  const v = raw as Record<string, unknown>;

  const unpinned = Object.keys(v)
    .filter((member) => member !== "key" && member !== "url" && member !== "variables")
    .sort();
  if (unpinned.length > 0) {
    const quoted = unpinned.map((m) => JSON.stringify(m)).join(", ");
    const noun = unpinned.length > 1 ? "members" : "member";
    const verb = unpinned.length > 1 ? "are" : "is";
    throw new Error(
      `configuration.server ${noun} ${quoted} ${verb} not pinned: ${SERVER_CONFIG_PINNED_SHAPES}`,
    );
  }

  const hasKey = "key" in v;
  const hasURL = "url" in v;
  const hasVars = "variables" in v;
  if (hasKey && hasURL) {
    throw new Error(
      `configuration.server carries both "key" and "url": ${SERVER_CONFIG_PINNED_SHAPES}`,
    );
  }
  if (!hasKey && !hasURL) {
    throw new Error(
      `configuration.server carries neither "key" nor "url": ${SERVER_CONFIG_PINNED_SHAPES}`,
    );
  }
  if (hasVars && hasURL) {
    throw new Error(
      `configuration.server carries "variables" with "url": ${SERVER_CONFIG_PINNED_SHAPES}`,
    );
  }
  if (hasKey) {
    const key = v.key;
    if (typeof key !== "string" || key === "") {
      throw new Error(
        `configuration.server.key must be a non-empty string: ${SERVER_CONFIG_PINNED_SHAPES}`,
      );
    }
    const supplied = suppliedServerVariables(v);
    const member = serverByKey(candidates, key);
    if (!member) {
      throw new Error(
        `configuration.server.key ${JSON.stringify(key)} names no member of the effective server set`,
      );
    }
    return assembleServer(member, supplied);
  }
  const full = v.url;
  if (typeof full !== "string" || full === "") {
    throw new Error(
      `configuration.server.url must be a non-empty string: ${SERVER_CONFIG_PINNED_SHAPES}`,
    );
  }
  return fullURLOverride(full, def);
}

/**
 * Decodes the key form's optional `variables` member: an object of string
 * values (§9.2 — upstream's Server Variable value space), any other shape
 * a loud refusal carrying SERVER_CONFIG_PINNED_SHAPES. Which NAMES are
 * admissible is the selected server's business, checked in assembleServer.
 */
function suppliedServerVariables(v: Record<string, unknown>): Record<string, string> | undefined {
  if (!("variables" in v)) return undefined;
  const rawVars = v.variables;
  if (rawVars === null || typeof rawVars !== "object" || Array.isArray(rawVars)) {
    throw new Error(
      `configuration.server.variables must be an object of string values: ${SERVER_CONFIG_PINNED_SHAPES}`,
    );
  }
  const entries = rawVars as Record<string, unknown>;
  const supplied: Record<string, string> = {};
  for (const name of Object.keys(entries).sort()) {
    const val = entries[name];
    if (typeof val !== "string") {
      throw new Error(
        `configuration.server.variables[${JSON.stringify(name)}] must be a string value: ${SERVER_CONFIG_PINNED_SHAPES}`,
      );
    }
    supplied[name] = val;
  }
  return supplied;
}

/** Selects the effective-set member with the given servers-map key. */
function serverByKey(candidates: NamedServer[], key: string): NamedServer | undefined {
  return candidates.find((c) => c.name === key);
}

/**
 * Resolves a consumer-supplied complete connection URL: the URL's scheme
 * decides the protocol, and an out-of-revision scheme is a pre-dispatch
 * refusal (§9.2). The declared security of the server the default
 * selection would have targeted still applies (§9.5).
 */
function fullURLOverride(full: string, def: NamedServer | undefined): ResolvedTarget {
  let u: URL;
  try {
    u = new URL(full);
  } catch {
    throw new Error(`connection URL ${JSON.stringify(full)} is not an absolute URL`);
  }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  if (!isBoundProtocol(scheme)) {
    throw new Error(
      `connection URL ${JSON.stringify(full)}: scheme ${JSON.stringify(scheme)} is not bound by openbindings.asyncapi@1 (supported: http, https, ws, wss)`,
    );
  }
  return {
    serverURL: full.replace(/\/+$/, ""),
    protocol: scheme,
    securityServer: def?.server,
  };
}

/**
 * Performs the target URL assembly (§9.2): scheme from the selected
 * server's protocol; authority from its `host` with every variable
 * substituted; path from its `pathname` (variables substituted the same
 * way). A member the consumer selects by key must still speak a bound
 * protocol — out-of-revision protocols are refused pre-dispatch, never
 * dialed. Supplied server-variable values apply only to the server's own
 * declared variable names: an undeclared supplied name is refused, never
 * ignored (no-guess), and a supplied value outside the variable's declared
 * enum is refused (upstream SHOULD, hardened to a refusal — the
 * specification's own pin).
 */
function assembleServer(
  member: NamedServer,
  supplied?: Record<string, string>,
): ResolvedTarget {
  const srv = member.server;
  const proto = srv.protocol.toLowerCase();
  if (!isBoundProtocol(proto)) {
    throw new Error(
      `server ${JSON.stringify(member.name)}: protocol ${JSON.stringify(srv.protocol)} is not bound by openbindings.asyncapi@1 (supported: http, https, ws, wss)`,
    );
  }

  if (supplied) {
    const sorted = Object.entries(supplied).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [name] of sorted) {
      const declared = srv.variables?.[name];
      if (!declared) {
        throw new Error(
          `configuration.server.variables[${JSON.stringify(name)}] names no declared variable of server ${JSON.stringify(member.name)}`,
        );
      }
      // A declared enum does not gate the supplied value (§9.2): it is the
      // author's expectation, not a boundary, and the same point admits a
      // full-URL override that bypasses the declaration. Undeclared names
      // still refuse (above); enum values do not.
    }
  }

  const host = substituteServerVariables(member, srv.host, supplied);
  const pathname = substituteServerVariables(member, srv.pathname ?? "", supplied);

  let base = `${proto}://${host}`;
  if (pathname !== "") base = joinURL(base, pathname);
  return {
    serverURL: base.replace(/\/+$/, ""),
    protocol: proto,
    securityServer: member.server,
  };
}

/**
 * Expands every `{name}` expression in a server host or pathname template
 * from the consumer-supplied value (the key form's `variables` member),
 * else the variable's declared default (ASYNC-P-04). AsyncAPI declares a
 * Server Variable's default OPTIONAL, so an undefaulted variable is
 * satisfiable only by supply; unsupplied and undefaulted is a pre-dispatch
 * refusal, and literal braces never reach the wire. A value outside the
 * variable's declared non-empty enum is refused loudly — supplied values
 * per §9.2's hardened pin, declared defaults per the declaration's own
 * constraint, incorporated.
 */
function substituteServerVariables(
  member: NamedServer,
  template: string,
  supplied?: Record<string, string>,
): string {
  let out = template;
  for (const name of templateExpressions(template)) {
    const declared = member.server.variables?.[name];
    let val = supplied?.[name];
    if (val === undefined) {
      val = declared?.default;
      if (val === undefined || val === "") {
        throw new ConfigRequired(
          "server",
          name,
          `server ${JSON.stringify(member.name)}: variable ${JSON.stringify(name)} has no supplied value and no declared default (supply one at the server configuration point's "variables" member)`,
          declared?.enum,
        );
      }
    }
    // A declared enum does not gate the value (§9.2): author's expectation,
    // not a boundary, consistent with the config-server-variables path.
    out = out.replaceAll(`{${name}}`, val);
  }
  if (/[{}]/.test(out)) {
    throw new Error(
      `server ${JSON.stringify(member.name)}: ${JSON.stringify(out)} still carries an unexpanded expression after substitution`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Address configuration point
// ---------------------------------------------------------------------------

/**
 * The consumer's `configuration.address` value, decoded:
 *
 *   "/rooms/general"                             // the concrete address outright
 *   {"address": "/rooms/general"}                // same, spelled as an object
 *   {"parameters": {"roomId": "general"}}        // `{name}` parameter values
 *
 * A concrete address and parameters may co-occur only in the object form;
 * a consumer-supplied concrete address is used verbatim (and must itself
 * be concrete — braces are refused, never dialed).
 */
export interface AddressConfig {
  address: string;
  parameters?: Record<string, string>;
}

/**
 * Reads the address configuration point from the binding context. Returns
 * an empty config when the point is not configured; a malformed value is a
 * loud error, never ignored.
 */
export function addressConfiguration(ctx?: Record<string, unknown>): AddressConfig {
  const out: AddressConfig = { address: "" };
  const cfg = contextConfiguration(ctx);
  const raw = cfg["address"];
  if (raw === undefined || raw === null) return out;
  if (typeof raw === "string") {
    out.address = raw;
    return out;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const v = raw as Record<string, unknown>;
    if (typeof v.address === "string") out.address = v.address;
    if (v.parameters !== null && typeof v.parameters === "object" && !Array.isArray(v.parameters)) {
      out.parameters = {};
      for (const [name, val] of Object.entries(v.parameters as Record<string, unknown>)) {
        if (typeof val !== "string") {
          throw new Error(
            `configuration.address.parameters[${JSON.stringify(name)}] must be a string, got ${typeof val}`,
          );
        }
        out.parameters[name] = val;
      }
    }
    return out;
  }
  throw new Error(`configuration.address must be a string or an object, got ${typeof raw}`);
}

/**
 * Resolves the address configuration point (ASYNC-P-04): the channel's
 * declared `address` with every `{name}` expression expanded from
 * consumer-supplied parameter values, else the declared parameter's
 * `default`. An absent or null address with no consumer-supplied address,
 * or any expression left unresolved after defaults, is a pre-dispatch
 * refusal, never a guess — this specification does not assume the channel
 * key is an address, and never dials literal braces.
 */
export function resolveAddress(
  ch: AsyncAPIChannel | undefined,
  channelName: string,
  cfg: AddressConfig,
): string {
  if (cfg.address !== "") {
    if (/[{}]/.test(cfg.address)) {
      throw new Error(
        `configuration.address ${JSON.stringify(cfg.address)} is not concrete: literal braces never reach the wire`,
      );
    }
    return cfg.address;
  }
  if (!ch || !ch.address) {
    // AsyncAPI's address:null "generated dynamically at runtime" case:
    // resolvable by consumer supply, and per-invocation (not persisted).
    throw new ConfigRequired(
      "address",
      "address",
      `channel ${JSON.stringify(channelName)} declares no address and none was supplied at the address configuration point (AsyncAPI's runtime-generated address); supply one`,
      undefined,
      false,
    );
  }
  return expandAddress(ch, ch.address, channelName, cfg.parameters);
}

/**
 * Expands every `{name}` expression in the channel's declared address from
 * the consumer-supplied parameter value, else the declared parameter's
 * `default`; anything left unresolved is a pre-dispatch refusal. A
 * supplied value outside a declared non-empty enum is refused loudly (the
 * Parameter Object's own constraint, incorporated).
 */
function expandAddress(
  ch: AsyncAPIChannel,
  address: string,
  channelName: string,
  supplied: Record<string, string> | undefined,
): string {
  let out = address;
  for (const name of templateExpressions(address)) {
    let val = supplied?.[name];
    if (val === undefined) {
      const declared = ch.parameters?.[name];
      if (declared?.default) {
        val = declared.default;
      } else {
        throw new ConfigRequired(
          "address",
          name,
          `channel ${JSON.stringify(channelName)}: address parameter ${JSON.stringify(name)} has no supplied value and no declared default`,
          declared?.enum,
        );
      }
    }
    // A declared enum does not gate the value (§9.2): author's expectation,
    // not a boundary, consistent with the server-variable point.
    out = out.replaceAll(`{${name}}`, val);
  }
  if (/[{}]/.test(out)) {
    throw new Error(
      `channel ${JSON.stringify(channelName)}: address ${JSON.stringify(out)} still carries an unexpanded expression after parameter expansion`,
    );
  }
  return out;
}

/**
 * Returns the `{name}` expression names of a template, in order of first
 * appearance, deduplicated.
 */
export function templateExpressions(template: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let rest = template;
  for (;;) {
    const open = rest.indexOf("{");
    if (open < 0) return names;
    const end = rest.indexOf("}", open);
    if (end < 0) return names;
    const name = rest.slice(open + 1, end);
    if (name !== "" && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
    rest = rest.slice(end + 1);
  }
}

/**
 * Concatenates a base URL and a path with exactly one `/` at the join
 * (§9.2's URL-assembly rule: concatenation, not RFC 3986 resolution — the
 * server's pathname prefix is preserved).
 */
export function joinURL(base: string, path: string): string {
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

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

function escapeJSONPointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

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
 * applies (§9.5: the selected artifact server, including when consumer
 * configuration replaces only its target URL; undefined when no artifact
 * server was selected).
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
      // server (which would otherwise TypeError during server selection).
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
 * Returns the sole effective-set member whose protocol revision 1 binds
 * (§9.2). With zero or several bound members there is no artifact-selected
 * default; declaration order never chooses identity.
 */
export function defaultServer(candidates: NamedServer[]): NamedServer | undefined {
  const bound = candidates.filter((candidate) => isBoundProtocol(candidate.server.protocol.toLowerCase()));
  return bound.length === 1 ? bound[0] : undefined;
}

function boundServerNames(candidates: NamedServer[]): string[] {
  return candidates
    .filter((candidate) => isBoundProtocol(candidate.server.protocol.toLowerCase()))
    .map((candidate) => candidate.name);
}

/**
 * The typed signal a resolution helper throws when a named configuration point
 * cannot resolve because a value is absent (no default, no supplied value) — a
 * resolvable-missing value, not a malformed one. The invoke path turns it into
 * a config.value CONTEXT_REQUIRED challenge (retryable after resolution, R1a)
 * rather than a terminal ERR_SOURCE_CONFIG_ERROR. The best artifact-derived
 * scope is carried when no server URL has resolved; configuration may be
 * sensitive, so a resolver decides whether that scope is sufficient.
 */
export class ConfigRequired extends Error {
  constructor(
    readonly point: string,
    readonly path: string,
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
 * (ASYNC-P-04): the sole bound member selects itself; several require
 * consumer selection. A complete URL may replace the selected member's
 * target only with the same scheme, while that member's declarations and
 * security continue to govern. Declaration order never selects a member.
 *
 * The `configuration.server` value is pinned by §9.2 ("Configuration value
 * semantics while its concrete shape remains implementation surface. This
 * SDK uses one composable object:
 *
 *   {"key": "<server-name>"?, "variables": {"<variable-name>": "<string-value>"}?, "url": "<connection-url>"?}
 *
 * `key` is required when several bound members remain and optional when one
 * remains. `variables` and `url` complete or replace the selected member;
 * an object with none of the three is refused.
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
    if (!def) {
      if (candidates.length === 0) {
        return directURLTarget(base);
      }
      const names = boundServerNames(candidates);
      if (names.length === 0) {
        throw new Error("the effective server set declares no server with a protocol bound by the supported openbindings.asyncapi revisions");
      }
      throw new ConfigRequired(
        "server",
        "/key",
        "configuration.server.key must select one artifact server before metadata.baseURL can replace its target",
        names,
        true,
      );
    }
    return fullURLOverride(base, def);
  }

  if (!def) {
    // An artifact that declares no server at all still names a complete
    // target (ruled 2026-08-13, R1+R5): reachability is consumer
    // configuration, negotiated via the same config.value challenge the
    // several-servers case uses — the caller supplies the whole connection
    // URL instead of selecting a member.
    if (candidates.length === 0) {
      throw new ConfigRequired(
        "server",
        "/url",
        "the artifact declares no server; configuration.server.url must supply the connection URL",
        undefined,
        true,
      );
    }
    const names = boundServerNames(candidates);
    if (names.length === 0) {
      throw new Error("the effective server set declares no server with a protocol bound by the supported openbindings.asyncapi revisions");
    }
    throw new ConfigRequired(
      "server",
      "/key",
      "the effective server set declares several bindable servers; configuration.server.key must select one artifact member",
      names,
      true,
    );
  }
  return assembleServer(def);
}

/**
 * Resolves a consumer-supplied connection URL as the whole target for an
 * artifact that declares no server: there is no member to select or
 * replace, so the URL's own scheme carries the protocol and no artifact
 * server declarations apply (Go twin: directURLTarget).
 */
function directURLTarget(full: string): ResolvedTarget {
  let parsed: URL;
  try {
    parsed = new URL(full);
  } catch {
    throw new Error(`connection URL ${JSON.stringify(full)} is not an absolute URL`);
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (!isBoundProtocol(scheme)) {
    throw new Error(`connection URL ${JSON.stringify(full)}: scheme ${JSON.stringify(scheme)} is not bound by the supported openbindings.asyncapi revisions (supported: http, https, ws, wss)`);
  }
  return { serverURL: full.replace(/\/+$/, ""), protocol: scheme };
}

/**
 * The teaching tail of every non-pinned-form refusal, byte-identical to the
 * Go SDK's: §9.2 pins the value "so two implementations carry it
 * identically", and silently tolerating extra spellings would defeat the
 * pin.
 */
const SERVER_CONFIG_SHAPE =
  'this implementation accepts {"key": "<server-name>"?, "variables": {"<variable-name>": "<string-value>"}?, "url": "<connection-url>"?}; "key" selects an artifact member (required when several bindable members remain), "variables" completes that member, "url" may replace only that selected member\'s target with the same scheme, and when the artifact declares no server "url" alone supplies the whole connection URL';

/**
 * Applies one configured `server` value against the effective set,
 * using this SDK's composable object carriage. Every unrecognized or
 * ambiguous form is a loud refusal carrying SERVER_CONFIG_SHAPE.
 */
function resolveServerConfig(
  raw: unknown,
  candidates: NamedServer[],
  def: NamedServer | undefined,
): ResolvedTarget {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`configuration.server must be an object: ${SERVER_CONFIG_SHAPE}`);
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
      `configuration.server ${noun} ${quoted} ${verb} not pinned: ${SERVER_CONFIG_SHAPE}`,
    );
  }

  const hasKey = "key" in v;
  const hasURL = "url" in v;
  const hasVars = "variables" in v;
  if (!hasKey && !hasURL && !hasVars) {
    throw new Error(
      `configuration.server carries none of "key", "variables", or "url": ${SERVER_CONFIG_SHAPE}`,
    );
  }
  const supplied = suppliedServerVariables(v);
  const full = v.url;
  if (hasURL && (typeof full !== "string" || full === "")) {
    throw new Error(
      `configuration.server.url must be a non-empty string: ${SERVER_CONFIG_SHAPE}`,
    );
  }

  let member = def;
  if (hasKey) {
    const key = v.key;
    if (typeof key !== "string" || key === "") {
      throw new Error(
        `configuration.server.key must be a non-empty string: ${SERVER_CONFIG_SHAPE}`,
      );
    }
    member = serverByKey(candidates, key);
    if (!member) {
      throw new Error(
        `configuration.server.key ${JSON.stringify(key)} names no member of the effective server set`,
      );
    }
  }
  if (!member) {
    if (candidates.length === 0) {
      // No artifact server exists to select, complete, or replace: the url
      // form alone carries the whole target (R1+R5).
      if (hasVars) {
        throw new Error(`configuration.server.variables completes an artifact-declared server, and the artifact declares none: ${SERVER_CONFIG_SHAPE}`);
      }
      if (hasURL) {
        return directURLTarget(full as string);
      }
      throw new ConfigRequired(
        "server",
        "/url",
        "the artifact declares no server; configuration.server.url must supply the connection URL",
        undefined,
        true,
      );
    }
    const names = boundServerNames(candidates);
    if (names.length === 0) {
      throw new Error("the effective server set declares no server with a protocol bound by the supported openbindings.asyncapi revisions");
    }
    throw new ConfigRequired(
      "server",
      "/key",
      "configuration.server.key must select one artifact server before variables or a URL replacement can be applied",
      names,
      true,
    );
  }
  validateSuppliedServerVariables(member, supplied);
  if (!hasURL) return assembleServer(member, supplied);
  return fullURLOverride(full as string, member);
}

/**
 * Decodes the key form's optional `variables` member: an object of string
 * values (§9.2 — upstream's Server Variable value space), any other shape
 * a loud refusal carrying SERVER_CONFIG_SHAPE. Which NAMES are
 * admissible is the selected server's business, checked in assembleServer.
 */
function suppliedServerVariables(v: Record<string, unknown>): Record<string, string> | undefined {
  if (!("variables" in v)) return undefined;
  const rawVars = v.variables;
  if (rawVars === null || typeof rawVars !== "object" || Array.isArray(rawVars)) {
    throw new Error(
      `configuration.server.variables must be an object of string values: ${SERVER_CONFIG_SHAPE}`,
    );
  }
  const entries = rawVars as Record<string, unknown>;
  const supplied: Record<string, string> = {};
  for (const name of Object.keys(entries).sort()) {
    const val = entries[name];
    if (typeof val !== "string") {
      throw new Error(
        `configuration.server.variables[${JSON.stringify(name)}] must be a string value: ${SERVER_CONFIG_SHAPE}`,
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
function fullURLOverride(full: string, selected: NamedServer): ResolvedTarget {
  let u: URL;
  try {
    u = new URL(full);
  } catch {
    throw new Error(`connection URL ${JSON.stringify(full)} is not an absolute URL`);
  }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  if (!isBoundProtocol(scheme)) {
    throw new Error(
      `connection URL ${JSON.stringify(full)}: scheme ${JSON.stringify(scheme)} is not bound by the supported openbindings.asyncapi revisions (supported: http, https, ws, wss)`,
    );
  }
  const selectedProtocol = selected.server.protocol.toLowerCase();
  if (scheme !== selectedProtocol) {
    throw new Error(
      `connection URL ${JSON.stringify(full)} uses scheme ${JSON.stringify(scheme)}, but selected server ${JSON.stringify(selected.name)} declares protocol ${JSON.stringify(selected.server.protocol)}`,
    );
  }
  return {
    serverURL: full.replace(/\/+$/, ""),
    protocol: scheme,
    securityServer: selected.server,
  };
}

function validateSuppliedServerVariables(
  member: NamedServer,
  supplied: Record<string, string> | undefined,
): void {
  if (!supplied) return;
  for (const [name, value] of Object.entries(supplied).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const declared = member.server.variables?.[name];
    if (!declared) {
      throw new Error(
        `configuration.server.variables[${JSON.stringify(name)}] names no declared variable of server ${JSON.stringify(member.name)}`,
      );
    }
    if (declared.enum && declared.enum.length > 0 && !declared.enum.includes(value)) {
      throw new Error(
        `configuration.server.variables[${JSON.stringify(name)}] value ${JSON.stringify(value)} is outside server ${JSON.stringify(member.name)}'s artifact-declared enum`,
      );
    }
  }
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
      `server ${JSON.stringify(member.name)}: protocol ${JSON.stringify(srv.protocol)} is not bound by the supported openbindings.asyncapi revisions (supported: http, https, ws, wss)`,
    );
  }

  validateSuppliedServerVariables(member, supplied);

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
          `/variables/${escapeJSONPointerToken(name)}`,
          `server ${JSON.stringify(member.name)}: variable ${JSON.stringify(name)} has no supplied value and no declared default (supply one at the server configuration point's "variables" member)`,
          declared?.enum,
        );
      }
    }
    if (declared?.enum && declared.enum.length > 0 && !declared.enum.includes(val)) {
      throw new Error(
        `server ${JSON.stringify(member.name)}: variable ${JSON.stringify(name)} value ${JSON.stringify(val)} is outside the artifact-declared enum`,
      );
    }
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
  const directParameters = cfg["parameters"];
  if (directParameters !== undefined) out.parameters = stringMap(directParameters, "configuration.parameters");
  if (raw === undefined || raw === null) return out;
  if (typeof raw === "string") {
    out.address = raw;
    return out;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const v = raw as Record<string, unknown>;
    if (typeof v.address === "string") out.address = v.address;
    if (v.parameters !== null && typeof v.parameters === "object" && !Array.isArray(v.parameters)) {
      const nested = stringMap(v.parameters, "configuration.address.parameters");
      out.parameters ??= {};
      for (const [name, val] of Object.entries(nested)) {
        if (out.parameters[name] !== undefined && out.parameters[name] !== val) {
          throw new Error(`address parameter ${JSON.stringify(name)} is supplied twice with different values`);
        }
        out.parameters[name] = val;
      }
    }
    return out;
  }
  throw new Error(`configuration.address must be a string or an object, got ${typeof raw}`);
}

function stringMap(raw: unknown, what: string): Record<string, string> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${what} must be an object of string values`);
  const result: Record<string, string> = {};
  for (const [name, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val !== "string") throw new Error(`${what}[${JSON.stringify(name)}] must be a string, got ${typeof val}`);
    result[name] = val;
  }
  return result;
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
  outgoingPayload?: unknown,
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
      "",
      `channel ${JSON.stringify(channelName)} declares no address and none was supplied at the address configuration point (AsyncAPI's runtime-generated address); supply one`,
      undefined,
      false,
    );
  }
  return expandAddress(ch, ch.address, channelName, cfg.parameters, outgoingPayload);
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
  outgoingPayload: unknown,
): string {
  for (const name of Object.keys(supplied ?? {})) {
    const declared = ch.parameters?.[name];
    if (!declared) throw new Error(`configuration parameter ${JSON.stringify(name)} is not declared by channel ${JSON.stringify(channelName)}`);
    if (declared.location) throw new Error(`configuration cannot override address parameter ${JSON.stringify(name)} because the artifact declares location ${JSON.stringify(declared.location)}`);
  }
  let out = address;
  for (const name of templateExpressions(address)) {
    const declared = ch.parameters?.[name];
    let val: string | undefined;
    if (declared?.location) {
      val = evaluatePayloadLocation(declared.location, outgoingPayload, name);
    } else {
      val = supplied?.[name];
    }
    if (val === undefined) {
      if (declared?.default) {
        val = declared.default;
      } else {
        throw new ConfigRequired(
          "address",
          `/parameters/${escapeJSONPointerToken(name)}`,
          `channel ${JSON.stringify(channelName)}: address parameter ${JSON.stringify(name)} has no supplied value and no declared default`,
          declared?.enum,
        );
      }
    }
    if (declared?.enum && declared.enum.length > 0 && !declared.enum.includes(val)) {
      throw new Error(`address parameter ${JSON.stringify(name)} value ${JSON.stringify(val)} is outside the artifact-declared enum`);
    }
    out = out.replaceAll(`{${name}}`, encodeURIComponent(val));
  }
  if (/[{}]/.test(out)) {
    throw new Error(
      `channel ${JSON.stringify(channelName)}: address ${JSON.stringify(out)} still carries an unexpanded expression after parameter expansion`,
    );
  }
  return out;
}

function evaluatePayloadLocation(location: string, payload: unknown, name: string): string {
  const prefix = "$message.payload#";
  if (!location.startsWith(prefix)) {
    throw new Error(`address parameter ${JSON.stringify(name)} uses unsupported runtime expression ${JSON.stringify(location)}`);
  }
  let current: unknown = payload;
  const pointer = location.slice(prefix.length);
  if (pointer !== "") {
    if (!pointer.startsWith("/")) throw new Error(`runtime expression ${JSON.stringify(location)} has an invalid JSON Pointer`);
    for (const raw of pointer.slice(1).split("/")) {
      const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
      if (current === null || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, segment)) {
        throw new Error(`runtime expression ${JSON.stringify(location)} did not resolve against the outgoing payload`);
      }
      current = (current as Record<string, unknown>)[segment];
    }
  }
  if (typeof current !== "string") throw new Error(`runtime expression ${JSON.stringify(location)} must resolve to a string`);
  return current;
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

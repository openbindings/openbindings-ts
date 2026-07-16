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
 *  configuration can select a member by name and so security derivation
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
      if (name !== "" && name in docServers) {
        out.push({ name, server: docServers[name] });
      }
    }
    return out;
  }
  return Object.keys(docServers)
    .sort()
    .map((name) => ({ name, server: docServers[name] }));
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
 * Resolves the server configuration point for the operation's channel
 * (ASYNC-P-04): consumer configuration may select another member of the
 * effective set or supply a complete connection URL outright; the default
 * is the effective set's first bound-protocol candidate. Under a full-URL
 * override the URL's scheme decides the protocol (out-of-revision schemes
 * refused) and the declared security of the server the default would have
 * selected still applies (§9.5). No resolvable server is a pre-dispatch
 * refusal.
 *
 * Accepted `configuration.server` shapes:
 *
 *   "prod"                                  // select the effective-set member by name
 *   "wss://api.example.com/v2"              // complete connection URL outright
 *   {"name": "prod"}                        // select by name
 *   {"url": "wss://api.example.com/v2"}     // complete connection URL outright
 *   {"variables": {"env": "staging"}}       // server-variable values (compose with name)
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

  if (!def) throw new Error(NO_RESOLVABLE_SERVER);
  return assembleServer(def, undefined);
}

/** Applies one configured `server` value against the effective set. */
function resolveServerConfig(
  raw: unknown,
  candidates: NamedServer[],
  def: NamedServer | undefined,
): ResolvedTarget {
  if (typeof raw === "string") {
    const member = serverByName(candidates, raw);
    if (member) return assembleServer(member, undefined);
    if (isAbsoluteURL(raw)) return fullURLOverride(raw, def);
    throw new Error(
      `configuration.server ${JSON.stringify(raw)} names no member of the effective server set and is not an absolute connection URL`,
    );
  }
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const v = raw as Record<string, unknown>;
    if (typeof v.url === "string" && v.url !== "") {
      return fullURLOverride(v.url, def);
    }
    let selected = def;
    if (typeof v.name === "string" && v.name !== "") {
      selected = serverByName(candidates, v.name);
      if (!selected) {
        throw new Error(
          `configuration.server.name ${JSON.stringify(v.name)} names no member of the effective server set`,
        );
      }
    }
    if (!selected) throw new Error(NO_RESOLVABLE_SERVER);
    let vars: Record<string, string> | undefined;
    if (v.variables !== null && typeof v.variables === "object" && !Array.isArray(v.variables)) {
      vars = {};
      for (const [name, val] of Object.entries(v.variables as Record<string, unknown>)) {
        if (typeof val !== "string") {
          throw new Error(
            `configuration.server.variables[${JSON.stringify(name)}] must be a string, got ${typeof val}`,
          );
        }
        vars[name] = val;
      }
    }
    return assembleServer(selected, vars);
  }
  throw new Error(`configuration.server must be a string or an object, got ${typeof raw}`);
}

/** Selects the effective-set member with the given servers-map key. */
function serverByName(candidates: NamedServer[], name: string): NamedServer | undefined {
  return candidates.find((c) => c.name === name);
}

function isAbsoluteURL(s: string): boolean {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
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
 * way). A member the consumer selects by name must still speak a bound
 * protocol — out-of-revision protocols are refused pre-dispatch, never
 * dialed.
 */
function assembleServer(
  member: NamedServer,
  supplied: Record<string, string> | undefined,
): ResolvedTarget {
  const srv = member.server;
  const proto = srv.protocol.toLowerCase();
  if (!isBoundProtocol(proto)) {
    throw new Error(
      `server ${JSON.stringify(member.name)}: protocol ${JSON.stringify(srv.protocol)} is not bound by openbindings.asyncapi@1 (supported: http, https, ws, wss)`,
    );
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
 * from the consumer-supplied value, else the variable's declared default
 * (ASYNC-P-04). An unsubstitutable variable is a pre-dispatch refusal, and
 * literal braces never reach the wire. A supplied value outside a declared
 * non-empty enum is refused loudly (the declaration's own constraint,
 * incorporated).
 */
function substituteServerVariables(
  member: NamedServer,
  template: string,
  supplied: Record<string, string> | undefined,
): string {
  let out = template;
  for (const name of templateExpressions(template)) {
    let val = supplied?.[name];
    if (val === undefined) {
      const declared = member.server.variables?.[name];
      if (declared?.default) {
        val = declared.default;
      } else {
        throw new Error(
          `server ${JSON.stringify(member.name)}: variable ${JSON.stringify(name)} has no supplied value and no declared default`,
        );
      }
    }
    const declared = member.server.variables?.[name];
    if (declared?.enum && declared.enum.length > 0 && !declared.enum.includes(val)) {
      throw new Error(
        `server ${JSON.stringify(member.name)}: variable ${JSON.stringify(name)} value ${JSON.stringify(val)} is not in the declared enum [${declared.enum.join(", ")}]`,
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
    throw new Error(
      `channel ${JSON.stringify(channelName)} declares no address and none was supplied at the address configuration point: an absent address is a refusal, never a guess`,
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
        throw new Error(
          `channel ${JSON.stringify(channelName)}: address parameter ${JSON.stringify(name)} has no supplied value and no declared default`,
        );
      }
    }
    const declared = ch.parameters?.[name];
    if (declared?.enum && declared.enum.length > 0 && !declared.enum.includes(val)) {
      throw new Error(
        `channel ${JSON.stringify(channelName)}: address parameter ${JSON.stringify(name)} value ${JSON.stringify(val)} is not in the declared enum [${declared.enum.join(", ")}]`,
      );
    }
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

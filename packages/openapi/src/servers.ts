import { contextConfiguration, contextMetadata } from "@openbindings/sdk";
import type { OpenAPIDocument, OpenAPIOperation, OpenAPIPathItem } from "./types.js";

// This file implements §9.3 of openbindings.openapi@1 (OAPI-P-05): the
// target URL's server half. Server resolution is a named configuration
// point; consultation order (§9.4) is per-invocation configuration →
// consumer-level configuration → the default. Both configuration tiers
// arrive merged in the binding context's `configuration` field (the
// operation invoker resolves consumer-level context into the same carrier),
// so this file consults one merged value. Mirrors the Go SDK's
// formats/openapi/servers.go.

/** One declared server entry (url template + variables), as the OAS spells it. */
interface ServerEntry {
  url: string;
  variables?: Record<string, { default?: string; enum?: string[]; [key: string]: unknown }>;
}

/**
 * Resolves the operation's server per OAPI-P-05:
 *
 *   - The effective server list is the OAS's: the operation's `servers`,
 *     else the path item's, else the document's, else the implied
 *     `url: "/"`.
 *
 *   - The default selects the effective list's first entry with each server
 *     variable substituted by its declared default.
 *
 *   - Consumer configuration (context.configuration.server) may instead
 *     select another entry, supply variable values, or supply a complete
 *     base URL outright. Accepted shapes:
 *
 *     "https://api.example.com"               (absolute base URL outright)
 *     "https://{env}.example.com"             (string matching a declared entry's url)
 *     {"baseUrl": "https://api.example.com"}  (absolute base URL outright)
 *     {"url": "https://{env}.example.com"}    (select the declared entry with that url)
 *     {"index": 1}                            (select the effective list's Nth entry)
 *     {"variables": {"env": "staging"}}       (server-variable values, enum-validated)
 *
 *     `url`/`index` and `variables` compose; `baseUrl` stands alone.
 *
 *   - A relative effective-server URL (the implied "/" included) resolves
 *     against the artifact's base URI (§6: the source's location) per
 *     RFC 3986. The one pre-dispatch refusal is a server URL that cannot
 *     resolve to an absolute URL.
 *
 * The legacy context.metadata.baseURL override is honored below the
 * configuration point (the configuration point is the contract surface).
 */
export function resolveServer(
  doc: OpenAPIDocument,
  pathItem: OpenAPIPathItem | null,
  op: OpenAPIOperation | null,
  bindCtx: Record<string, unknown> | undefined,
  sourceLocation: string | undefined,
): string {
  const servers = effectiveServers(doc, pathItem, op);

  const cfg = contextConfiguration(bindCtx);
  if (cfg["server"] != null) {
    const resolved = resolveServerConfig(cfg["server"], servers);
    return absolutizeServerURL(resolved, sourceLocation);
  }

  const metaBase = contextMetadata(bindCtx)["baseURL"];
  if (typeof metaBase === "string" && metaBase !== "") {
    return absolutizeServerURL(metaBase, sourceLocation);
  }

  const substituted = substituteServerVariables(servers[0], undefined);
  return absolutizeServerURL(substituted, sourceLocation);
}

/**
 * The OAS effective server list: operation servers, else path-item servers,
 * else document servers, else the OAS-defined implied server of url "/".
 */
export function effectiveServers(
  doc: OpenAPIDocument,
  pathItem: OpenAPIPathItem | null,
  op: OpenAPIOperation | null,
): ServerEntry[] {
  const opServers = asServerList(op?.servers);
  if (opServers.length > 0) return opServers;
  const pathServers = asServerList(pathItem?.servers);
  if (pathServers.length > 0) return pathServers;
  const docServers = asServerList(doc?.servers);
  if (docServers.length > 0) return docServers;
  return [{ url: "/" }];
}

function asServerList(raw: unknown): ServerEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ServerEntry[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === "object" && typeof (entry as ServerEntry).url === "string") {
      out.push(entry as ServerEntry);
    }
  }
  return out;
}

/**
 * Applies one configured `server` value against the effective list,
 * returning the (possibly still relative) server URL.
 */
function resolveServerConfig(raw: unknown, servers: ServerEntry[]): string {
  if (typeof raw === "string") {
    const srv = serverByURL(servers, raw);
    if (srv) return substituteServerVariables(srv, undefined);
    if (isAbsoluteURL(raw)) return raw;
    throw new Error(
      `configuration.server "${raw}" matches no declared server entry and is not an absolute base URL`,
    );
  }
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const v = raw as Record<string, unknown>;
    const base = v["baseUrl"];
    if (typeof base === "string" && base !== "") {
      if (!isAbsoluteURL(base)) {
        throw new Error(`configuration.server.baseUrl "${base}" is not an absolute URL`);
      }
      return base;
    }
    let srv = servers[0];
    const entryURL = v["url"];
    if (typeof entryURL === "string" && entryURL !== "") {
      const found = serverByURL(servers, entryURL);
      if (!found) {
        throw new Error(`configuration.server.url "${entryURL}" matches no declared server entry`);
      }
      srv = found;
    } else if ("index" in v) {
      const idx = configIndex(v["index"]);
      if (idx === null || idx < 0 || idx >= servers.length) {
        throw new Error(
          `configuration.server.index ${JSON.stringify(v["index"])} is not a valid index into the effective server list (${servers.length} entries)`,
        );
      }
      srv = servers[idx];
    }
    let vars: Record<string, string> | undefined;
    const rawVars = v["variables"];
    if (rawVars !== null && typeof rawVars === "object" && !Array.isArray(rawVars)) {
      vars = {};
      for (const [name, val] of Object.entries(rawVars as Record<string, unknown>)) {
        if (typeof val !== "string") {
          throw new Error(`configuration.server.variables["${name}"] must be a string, got ${typeof val}`);
        }
        vars[name] = val;
      }
    }
    return substituteServerVariables(srv, vars);
  }
  throw new Error(`configuration.server must be a string or an object, got ${typeof raw}`);
}

/** Selects the declared entry whose url template matches exactly. */
function serverByURL(servers: ServerEntry[], u: string): ServerEntry | null {
  for (const srv of servers) {
    if (srv.url === u) return srv;
  }
  return null;
}

function configIndex(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  return null;
}

/**
 * Substitutes each declared server variable with the supplied value
 * (validated against the variable's enum, per the OAS) or its declared
 * default. A variable with neither a supplied value nor a declared
 * default, and a supplied variable the entry does not declare, are loud
 * errors.
 */
function substituteServerVariables(
  srv: ServerEntry,
  supplied: Record<string, string> | undefined,
): string {
  let u = srv.url;
  const variables = srv.variables ?? {};
  for (const name of Object.keys(variables).sort()) {
    const v = variables[name];
    if (!v || typeof v !== "object") continue;
    const declaredDefault = typeof v.default === "string" ? v.default : "";
    const val = supplied && name in supplied ? supplied[name] : declaredDefault;
    if (val === "" && declaredDefault === "") {
      throw new Error(`server "${srv.url}": variable "${name}" has no supplied value and no declared default`);
    }
    if (Array.isArray(v.enum) && v.enum.length > 0 && !v.enum.includes(val)) {
      throw new Error(
        `server "${srv.url}": variable "${name}" value "${val}" is not in the declared enum [${v.enum.join(", ")}]`,
      );
    }
    u = u.replaceAll(`{${name}}`, val);
  }
  for (const name of Object.keys(supplied ?? {})) {
    if (!(name in variables)) {
      throw new Error(`server "${srv.url}" declares no variable "${name}"`);
    }
  }
  return u;
}

/** True when the string parses as an absolute URI (it carries a scheme). */
function isAbsoluteURL(s: string): boolean {
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return false;
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a (possibly relative) server URL to an absolute URL: absolute
 * URLs pass through; relative ones resolve against the artifact's base URI
 * — the source's location (§6) — per RFC 3986. A server URL that cannot
 * resolve to an absolute URL is the §9.3 pre-dispatch refusal. The
 * returned URL carries no trailing slash, so joining with the operation's
 * path template is concatenation.
 */
export function absolutizeServerURL(serverURL: string, sourceLocation: string | undefined): string {
  if (isAbsoluteURL(serverURL)) {
    return serverURL.replace(/\/+$/, "");
  }
  if (sourceLocation && isAbsoluteURL(sourceLocation)) {
    try {
      return new URL(serverURL, sourceLocation).toString().replace(/\/+$/, "");
    } catch {
      // fall through to the refusal
    }
  }
  throw new Error(
    `server URL "${serverURL}" cannot resolve to an absolute URL: the source has no absolute-URI location to serve as the artifact's base URI`,
  );
}

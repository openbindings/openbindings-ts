/**
 * Declared protocol `bindings` objects, honored where they speak
 * (openbindings.asyncapi@1 §8, ASYNC-P-02): an http operation binding's
 * `method` selects the request method; a websockets channel binding's
 * `method`, `query`, and `headers` govern the upgrade request, with
 * declared query and header values supplied like address parameters (§9.2)
 * and any unsatisfied required declaration a pre-dispatch refusal. Where
 * bindings are silent, the cell defaults apply (POST for a unary publish,
 * GET for an SSE subscription, a GET upgrade). Mirrors the Go SDK's
 * bindings.go.
 */

import type { AsyncAPIChannel, AsyncAPIOperation } from "./asyncapi-types.js";

/**
 * Returns the request method for an http-protocol cell: the http operation
 * binding's `method` where declared, else the cell's default.
 */
export function requestMethod(op: AsyncAPIOperation | undefined, cellDefault: string): string {
  const declared = op?.bindings?.http?.method;
  if (declared) return declared.trim().toUpperCase();
  return cellDefault;
}

/**
 * The websockets channel binding's resolved contribution to the upgrade
 * request: query values (which join the dialed URL, and so the pool key)
 * and header values (applied to the upgrade request, and hashed into the
 * connection's credential identity).
 */
export interface WSUpgrade {
  query?: Record<string, string>;
  headers?: Record<string, string>;
}

/**
 * Resolves the websockets channel binding against the consumer-supplied
 * values. Declared query and header property values come from the
 * address-parameter bag ("supplied like address parameters", §8) — headers
 * additionally from the context's generic header carriage, whose values
 * reach the upgrade request through applyContext — else the property's
 * declared `default`; a `required` declaration left unsatisfied is a
 * pre-dispatch refusal. A declared upgrade `method` other than GET is
 * refused loudly: RFC 6455 upgrades are GET requests and this platform
 * cannot apply another method — surfaced, never silently rerouted.
 */
export function resolveWSUpgrade(
  ch: AsyncAPIChannel | undefined,
  channelName: string,
  params: Record<string, string> | undefined,
  ctxHeaders: Record<string, string>,
): WSUpgrade {
  const up: WSUpgrade = {};
  const b = ch?.bindings?.ws;
  if (!b) return up;

  if (b.method && b.method.trim().toUpperCase() !== "GET") {
    throw new Error(
      `channel ${JSON.stringify(channelName)}: websockets binding declares upgrade method ${JSON.stringify(b.method)}, which this platform cannot apply (RFC 6455 upgrades are GET) — refused rather than silently rerouted`,
    );
  }

  up.query = schemaPropertyValues(
    b.query,
    params,
    undefined,
    `channel ${JSON.stringify(channelName)}: websockets binding query parameter`,
  );
  up.headers = schemaPropertyValues(
    b.headers,
    params,
    ctxHeaders,
    `channel ${JSON.stringify(channelName)}: websockets binding header`,
  );
  return up;
}

/**
 * Resolves the declared properties of a ws-binding `query`/`headers`
 * Schema Object: each declared property takes the consumer-supplied value,
 * else a satisfied generic-carriage value (headers only; the value already
 * rides the request, so it resolves the declaration without being
 * duplicated here), else the property's declared `default`. A `required`
 * property left unresolved is a pre-dispatch refusal (ASYNC-P-02). Only
 * scalar defaults map to a wire value.
 */
function schemaPropertyValues(
  schema: Record<string, unknown> | undefined,
  supplied: Record<string, string> | undefined,
  satisfiedElsewhere: Record<string, string> | undefined,
  what: string,
): Record<string, string> | undefined {
  if (!schema) return undefined;
  const props =
    schema.properties !== null && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  const required = new Set<string>(
    Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : [],
  );

  const names = new Set<string>([...Object.keys(props), ...required]);

  const out: Record<string, string> = {};
  for (const name of names) {
    const suppliedVal = supplied?.[name];
    if (suppliedVal !== undefined) {
      out[name] = suppliedVal;
      continue;
    }
    if (satisfiedElsewhere && hasCaseInsensitive(satisfiedElsewhere, name)) {
      continue; // already riding the request via the generic carriage
    }
    const prop = props[name];
    if (prop !== null && typeof prop === "object" && !Array.isArray(prop)) {
      const def = stringifyScalar((prop as Record<string, unknown>).default);
      if (def !== undefined) {
        out[name] = def;
        continue;
      }
    }
    if (required.has(name)) {
      throw new Error(`${what} ${JSON.stringify(name)} is required but has no supplied value and no declared default`);
    }
  }
  if (Object.keys(out).length === 0) return undefined;
  return out;
}

/** Reports whether `m` carries `key` under HTTP header case-insensitivity. */
function hasCaseInsensitive(m: Record<string, string>, key: string): boolean {
  const lower = key.toLowerCase();
  return Object.keys(m).some((k) => k.toLowerCase() === lower);
}

/**
 * Renders a JSON-schema scalar default as a wire value. Structured values
 * (objects, arrays, null) resolve nothing.
 */
function stringifyScalar(v: unknown): string | undefined {
  switch (typeof v) {
    case "string":
      return v;
    case "boolean":
      return String(v);
    case "number":
      return String(v);
  }
  return undefined;
}

/**
 * Appends resolved ws-binding query values onto an expanded address,
 * keeping the result a single dialable path-and-query string (so the pool
 * key and the dialed URL always agree). Keys are appended in sorted order
 * for a deterministic pool key (mirrors Go's url.Values.Encode).
 */
export function mergeQuery(address: string, q: Record<string, string> | undefined): string {
  if (!q || Object.keys(q).length === 0) return address;
  const params = new URLSearchParams();
  for (const key of Object.keys(q).sort()) params.set(key, q[key]);
  const sep = address.includes("?") ? "&" : "?";
  return address + sep + params.toString();
}

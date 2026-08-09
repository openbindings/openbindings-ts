import type { OpenAPIParameter, OpenAPIPathItem, OpenAPIOperation } from "./types.js";
import { mergeParameters } from "./util.js";
import { isJSONMediaType, normalizeMediaType, type BodyPlan } from "./media.js";
import { BINDING_SPEC_V2 } from "./constants.js";

// This file implements the flattened input model of openbindings.openapi@1
// §9.1 (OAPI-P-02, OAPI-P-03): the caller-facing input value is one JSON
// object — parameters from every location and the request body merged into
// one object — and parameter serialization follows the OAS
// style/explode/allowReserved rules, incorporated wholesale. Mirrors the Go
// SDK's formats/openapi/params.go.

// ---------------------------------------------------------------------------
// Effective parameter set
// ---------------------------------------------------------------------------

const IGNORED_HEADER_PARAMS = new Set(["accept", "content-type", "authorization"]);

/**
 * Merges path-item and operation `parameters` (operation winning on same
 * name-and-location collision, per the OAS) and drops header parameters
 * named Accept, Content-Type, or Authorization: the OAS declares such
 * parameter definitions SHALL be ignored.
 */
export function effectiveParameters(
  pathItem: OpenAPIPathItem,
  op: OpenAPIOperation,
): OpenAPIParameter[] {
  const merged = mergeParameters(pathItem.parameters, op.parameters);
  return merged.filter((p) => {
    if (!p?.name || !p?.in) return false;
    if (p.in === "header" && IGNORED_HEADER_PARAMS.has(p.name.toLowerCase())) return false;
    return true;
  });
}

/**
 * Reports the first parameter name declared in two DIFFERENT locations
 * (legal per the OAS's name-plus-location identity, but unrepresentable by
 * the flattened model): such an operation is refused loudly at binding
 * resolution (OAPI-P-03). Empty string means flattenable.
 */
export function unflattenableParam(
  params: OpenAPIParameter[],
  bindingSpec: string = "openbindings.openapi@1",
): string {
  const locs = new Map<string, string>();
  const headerSpellings = new Map<string, string>();
  for (const p of params) {
    if (!p?.name || !p?.in) continue;
    const prev = locs.get(p.name);
    if (bindingSpec !== BINDING_SPEC_V2 && prev !== undefined && prev !== p.in) return p.name;
    locs.set(p.name, p.in);
    if (p.in === "header") {
      const folded = p.name.toLowerCase();
      const spelling = headerSpellings.get(folded);
      if (spelling !== undefined && spelling !== p.name) return p.name;
      headerSpellings.set(folded, p.name);
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Routing (the flatten, wire side)
// ---------------------------------------------------------------------------

/**
 * The flattened contract's property for a non-object request body (§9.1):
 * at the wire, its value IS the request body, unwrapped.
 */
export const SYNTHETIC_BODY_PROPERTY = "body";

/**
 * Marks the §9.1 always-refuses case — a supplied input missing a declared
 * path parameter — so the caller can map it to ERR_MISSING_INPUT rather
 * than the generic validation refusal.
 */
export class MissingPathParamError extends Error {}

/** The wire-side product of routing one flattened input object through the operation's declared surface. */
export interface RoutedInput {
  /** Path template with path parameters substituted. */
  resolvedPath: string;
  /** Fully percent-encoded name=value units, declaration order. */
  queryUnits: string[];
  headers: Array<[string, string]>;
  /** Raw name=value units, declaration order. */
  cookieUnits: string[];

  /** Object-mode body fields. */
  bodyFields: Record<string, unknown>;
  /** Synthetic-mode body value (§9.1: the `body` property, unwrapped at the wire). */
  bodyValue: unknown;
  bodySet: boolean;

  /**
   * Which declared parameters the caller populated, per channel (header
   * names lowercased), for the OAPI-P-10 credential-collision refusal.
   */
  populated: { header: Set<string>; query: Set<string>; cookie: Set<string> };
}

/**
 * Maps one flattened input object onto the wire per §9.1 (OAPI-P-03):
 *
 *   - declared parameters ride their location, serialized per the OAS
 *     style/explode/allowReserved rules (OAPI-P-02);
 *   - parameter/body name collisions are screened while selecting the
 *     request-media candidate; a routed field therefore has exactly one
 *     wire carriage;
 *   - a field matching no declared parameter or body property passes
 *     through into the body when a request body is declared, and is refused
 *     loudly before dispatch when none is declared;
 *   - a missing declared path parameter always refuses before dispatch (the
 *     URL cannot be built); every other missing member is the server's
 *     declared validation's business.
 */
export function routeInput(
  params: OpenAPIParameter[],
  input: Record<string, unknown>,
  pathTemplate: string,
  plan: BodyPlan | null,
): RoutedInput {
  const r: RoutedInput = {
    resolvedPath: pathTemplate,
    queryUnits: [],
    headers: [],
    cookieUnits: [],
    bodyFields: {},
    bodyValue: undefined,
    bodySet: false,
    populated: { header: new Set(), query: new Set(), cookie: new Set() },
  };

  const consumed = new Set<string>();
  const missingPath: string[] = [];

  for (const p of params) {
    if (!p?.name || !p?.in) continue;
    if (!(p.name in input)) {
      if (p.in === "path") missingPath.push(p.name);
      continue;
    }
    consumed.add(p.name);
    const value = input[p.name];

    routeParameter(r, p, value);
  }

  if (missingPath.length > 0) {
    missingPath.sort();
    throw new MissingPathParamError(
      `missing path parameter(s) ${missingPath.join(", ")}: the URL cannot be built without them`,
    );
  }

  // Fields matching no declared parameter.
  const unmatched: string[] = [];
  for (const name of Object.keys(input).sort()) {
    if (consumed.has(name)) continue;
    const value = input[name];
    if (!plan?.declared) {
      unmatched.push(name);
    } else if (plan.synthetic) {
      if (name === SYNTHETIC_BODY_PROPERTY) {
        r.bodyValue = value;
        r.bodySet = true;
      } else {
        // The flattened contract of a non-object body carries only
        // parameters and the synthetic `body` property; there is no object
        // body to pass through into.
        unmatched.push(name);
      }
    } else {
      // Evaluation-free body passthrough: no schema evaluation participates
      // in routing; enforcing the body schema is the server's business.
      r.bodyFields[name] = value;
    }
  }
  if (unmatched.length > 0) {
    if (plan?.declared && plan.synthetic) {
      throw new Error(
        `field(s) ${unmatched.join(", ")} match no declared parameter, and the declared request body is non-object (its flattened contract carries only the synthetic "${SYNTHETIC_BODY_PROPERTY}" property)`,
      );
    }
    throw new Error(
      `field(s) ${unmatched.join(", ")} match no declared parameter, and the operation declares no request body to pass them through to`,
    );
  }

  return r;
}

/**
 * The OAS serialization method for one parameter: its declared
 * style/explode with the OAS per-location defaults applied (path/header →
 * simple; query/cookie → form; explode defaults true for form, false
 * otherwise).
 */
export function serializationMethod(p: OpenAPIParameter): { style: string; explode: boolean } {
  let style = typeof p.style === "string" && p.style ? p.style : "";
  if (!style) {
    style = p.in === "query" || p.in === "cookie" ? "form" : "simple";
  }
  const explode = typeof p.explode === "boolean" ? p.explode : style === "form";
  return { style, explode };
}

/** Serializes one populated parameter onto its wire location. */
export function routeParameter(r: RoutedInput, p: OpenAPIParameter, value: unknown): void {
  const name = p.name ?? "";
  const allowReserved = p.allowReserved === true;

  // A `content`-form parameter (schema-less, a single-entry content map)
  // serializes its value per its declared media type and rides its location
  // as that serialized string (OAPI-P-02).
  const content = p.content as Record<string, unknown> | undefined;
  if (content && Object.keys(content).length > 0) {
    const serialized = serializeParamContent(p, value);
    switch (p.in) {
      case "path":
        r.resolvedPath = r.resolvedPath.replaceAll(`{${name}}`, encodePathValue(serialized));
        break;
      case "query":
        r.queryUnits.push(queryEscape(name, false) + "=" + queryEscape(serialized, allowReserved));
        r.populated.query.add(name);
        break;
      case "header":
        r.headers.push([name, serialized]);
        r.populated.header.add(name.toLowerCase());
        break;
      case "cookie":
        r.cookieUnits.push(name + "=" + serialized);
        r.populated.cookie.add(name);
        break;
      default:
        throw new Error(`parameter "${name}": unsupported location "${p.in}"`);
    }
    return;
  }

  const { style, explode } = serializationMethod(p);

  switch (p.in) {
    case "path": {
      let expanded: string;
      try {
        expanded = serializePathValue(name, value, style, explode);
      } catch (e) {
        throw new Error(`path parameter "${name}": ${(e as Error).message}`, { cause: e });
      }
      r.resolvedPath = r.resolvedPath.replaceAll(`{${name}}`, expanded);
      break;
    }
    case "query": {
      let units: string[];
      try {
        units = serializeQueryValue(name, value, style, explode, allowReserved);
      } catch (e) {
        throw new Error(`query parameter "${name}": ${(e as Error).message}`, { cause: e });
      }
      r.queryUnits.push(...units);
      r.populated.query.add(name);
      break;
    }
    case "header": {
      let v: string;
      try {
        v = serializeHeaderValue(value, style, explode);
      } catch (e) {
        throw new Error(`header parameter "${name}": ${(e as Error).message}`, { cause: e });
      }
      r.headers.push([name, v]);
      r.populated.header.add(name.toLowerCase());
      break;
    }
    case "cookie": {
      let units: string[];
      try {
        units = serializeCookieValue(name, value, style, explode);
      } catch (e) {
        throw new Error(`cookie parameter "${name}": ${(e as Error).message}`, { cause: e });
      }
      r.cookieUnits.push(...units);
      r.populated.cookie.add(name);
      break;
    }
    default:
      throw new Error(`parameter "${name}": unsupported location "${p.in}"`);
  }
}

/**
 * Serializes a content-form parameter's value per its declared media type:
 * JSON family values JSON-serialize; text/plain carries a string value
 * verbatim. Any other declared media type has no defined parameter carriage
 * in revision 1 and refuses loudly.
 */
export function serializeParamContent(p: OpenAPIParameter, value: unknown): string {
  const content = p.content as Record<string, unknown>;
  // The OAS requires exactly one entry; a malformed empty map yields the
  // zero-value key and falls to the loud no-carriage refusal below (Go
  // parity: the zero mediaKey takes the same path).
  const mediaKey = Object.keys(content)[0] ?? "";
  const mt = normalizeMediaType(mediaKey);
  if (isJSONMediaType(mt)) {
    return JSON.stringify(value);
  }
  if (mt === "text/plain") {
    if (typeof value !== "string") {
      throw new Error(
        `parameter "${p.name}" declares content "${mediaKey}": the value must be a string, got ${typeof value}`,
      );
    }
    return value;
  }
  throw new Error(
    `parameter "${p.name}" declares content "${mediaKey}": no parameter carriage is defined for that media type in openbindings.openapi@1`,
  );
}

// ---------------------------------------------------------------------------
// Style/explode expansions (OAPI-P-02: the OAS tables, incorporated wholesale)
// ---------------------------------------------------------------------------

type Escaper = (s: string) => string;

const identity: Escaper = (s) => s;

/**
 * Expands one path parameter per the OAS style table. Value pieces are
 * percent-encoded with the encodeURIComponent byte set (cross-SDK URL
 * parity); the style's structural characters (";", "=", ".", ",") stay
 * literal.
 */
export function serializePathValue(
  name: string,
  value: unknown,
  style: string,
  explode: boolean,
): string {
  switch (style) {
    case "simple":
      return expandSimple(value, explode, encodePathValue);
    case "label":
      return expandLabel(value, explode, encodePathValue);
    case "matrix":
      return expandMatrix(name, value, explode, encodePathValue);
    default:
      throw new Error(`style "${style}" is not defined for path parameters`);
  }
}

/**
 * Expands one header parameter (simple style only). Header values are not
 * percent-encoded: they are not URL components.
 */
export function serializeHeaderValue(value: unknown, style: string, explode: boolean): string {
  if (style !== "simple") {
    throw new Error(`style "${style}" is not defined for header parameters`);
  }
  return expandSimple(value, explode, identity);
}

/**
 * Expands one query parameter into fully percent-encoded name=value units,
 * per the OAS query styles. allowReserved lets RFC 3986 reserved characters
 * in VALUES pass unescaped.
 */
export function serializeQueryValue(
  name: string,
  value: unknown,
  style: string,
  explode: boolean,
  allowReserved: boolean,
): string[] {
  const n = queryEscape(name, false);
  const esc: Escaper = (s) => queryEscape(s, allowReserved);
  switch (style) {
    case "form":
      return expandFormPairs(n, value, explode, esc);
    case "spaceDelimited":
      return expandDelimited(n, value, explode, "%20", esc);
    case "pipeDelimited":
      return expandDelimited(n, value, explode, "|", esc);
    case "deepObject": {
      const obj = asObject(value);
      if (!obj) {
        throw new Error(`style deepObject is defined for objects only, got ${typeof value}`);
      }
      return objectPairs(obj).map(([k, v]) => `${n}[${queryEscape(k, false)}]=${esc(v)}`);
    }
    default:
      throw new Error(`style "${style}" is not defined for query parameters`);
  }
}

/**
 * Expands one cookie parameter (form style only) into raw name=value units,
 * which channel assembly (§9.6, OAPI-P-10) joins into the single Cookie
 * header with "; ". Cookie values are not percent-encoded (the OAS defines
 * no cookie escaping); exploded array/object expansions use the cookie
 * header's own pair separator rather than form's "&", which has no meaning
 * inside a Cookie header.
 */
export function serializeCookieValue(
  name: string,
  value: unknown,
  style: string,
  explode: boolean,
): string[] {
  if (style !== "form") {
    throw new Error(`style "${style}" is not defined for cookie parameters`);
  }
  return expandFormPairs(name, value, explode, identity);
}

/**
 * The OAS "simple" rows:
 *
 *     primitive        → v
 *     array (any expl) → a,b,c
 *     object false     → k1,v1,k2,v2
 *     object true      → k1=v1,k2=v2
 */
function expandSimple(value: unknown, explode: boolean, esc: Escaper): string {
  const arr = asArray(value);
  if (arr) return joinEscaped(arrayStrings(arr), ",", esc);
  const obj = asObject(value);
  if (obj) {
    const pairs = objectPairs(obj);
    if (explode) return joinPairs(pairs, "=", ",", esc);
    return joinEscaped(flattenPairs(pairs), ",", esc);
  }
  return esc(primitiveString(value));
}

/** The OAS "label" rows (the "." prefix, "." separators when exploded). */
function expandLabel(value: unknown, explode: boolean, esc: Escaper): string {
  const arr = asArray(value);
  if (arr) return "." + joinEscaped(arrayStrings(arr), explode ? "." : ",", esc);
  const obj = asObject(value);
  if (obj) {
    const pairs = objectPairs(obj);
    if (explode) return "." + joinPairs(pairs, "=", ".", esc);
    return "." + joinEscaped(flattenPairs(pairs), ",", esc);
  }
  return "." + esc(primitiveString(value));
}

/** The OAS "matrix" rows (";name=" prefixes; an empty primitive renders ";name"). */
function expandMatrix(name: string, value: unknown, explode: boolean, esc: Escaper): string {
  const n = esc(name);
  const arr = asArray(value);
  if (arr) {
    const parts = arrayStrings(arr);
    if (explode) return parts.map((p) => `;${n}=${esc(p)}`).join("");
    return `;${n}=` + joinEscaped(parts, ",", esc);
  }
  const obj = asObject(value);
  if (obj) {
    const pairs = objectPairs(obj);
    if (explode) return pairs.map(([k, v]) => `;${esc(k)}=${esc(v)}`).join("");
    return `;${n}=` + joinEscaped(flattenPairs(pairs), ",", esc);
  }
  const s = primitiveString(value);
  if (s === "") return `;${n}`;
  return `;${n}=${esc(s)}`;
}

/**
 * The OAS "form" rows as name=value units:
 *
 *     primitive        → [name=v]
 *     array false      → [name=a,b,c]
 *     array true       → [name=a name=b name=c]
 *     object false     → [name=k1,v1,k2,v2]
 *     object true      → [k1=v1 k2=v2]
 */
function expandFormPairs(name: string, value: unknown, explode: boolean, esc: Escaper): string[] {
  const arr = asArray(value);
  if (arr) {
    const parts = arrayStrings(arr);
    if (explode) return parts.map((p) => `${name}=${esc(p)}`);
    return [`${name}=` + joinEscaped(parts, ",", esc)];
  }
  const obj = asObject(value);
  if (obj) {
    const pairs = objectPairs(obj);
    if (explode) return pairs.map(([k, v]) => `${esc(k)}=${esc(v)}`);
    return [`${name}=` + joinEscaped(flattenPairs(pairs), ",", esc)];
  }
  return [`${name}=${esc(primitiveString(value))}`];
}

/**
 * spaceDelimited / pipeDelimited (defined by the OAS for arrays and
 * objects, explode=false; the delimiter separates the escaped pieces). An
 * exploded spaceDelimited/pipeDelimited parameter has no OAS-defined
 * expansion of its own — the delimiter is unused when each value rides its
 * own name=value pair — so it degrades to the form-style exploded
 * expansion, matching common OpenAPI tooling. Primitives are undefined for
 * these styles and refuse loudly.
 */
function expandDelimited(
  name: string,
  value: unknown,
  explode: boolean,
  delim: string,
  esc: Escaper,
): string[] {
  if (explode) {
    if (!asArray(value) && !asObject(value)) {
      throw new Error("spaceDelimited/pipeDelimited styles are not defined for primitives");
    }
    return expandFormPairs(name, value, true, esc);
  }
  const arr = asArray(value);
  if (arr) return [`${name}=` + joinEscaped(arrayStrings(arr), delim, esc)];
  const obj = asObject(value);
  if (obj) return [`${name}=` + joinEscaped(flattenPairs(objectPairs(obj)), delim, esc)];
  throw new Error("spaceDelimited/pipeDelimited styles are not defined for primitives");
}

// ---------------------------------------------------------------------------
// Value shaping helpers
// ---------------------------------------------------------------------------

/**
 * Renders a JSON primitive in its defined wire form: strings verbatim,
 * booleans as true/false, numbers in their canonical JSON rendering, null
 * as the empty string. Arrays and objects are not primitives.
 */
export function primitiveString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return JSON.stringify(v);
  throw new Error(`value of type ${typeof v} is not a primitive`);
}

export function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

export function asObject(v: unknown): Record<string, unknown> | null {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

/**
 * Renders each array element as a primitive string (nested arrays/objects
 * have no OAS-defined expansion inside a parameter value).
 */
function arrayStrings(arr: unknown[]): string[] {
  return arr.map((e, i) => {
    try {
      return primitiveString(e);
    } catch (err) {
      throw new Error(`array element ${i}: ${(err as Error).message}`, { cause: err });
    }
  });
}

/**
 * Renders an object's members as ordered [key, value] pairs, keys sorted
 * lexicographically for a deterministic expansion (JSON objects carry no
 * order).
 */
function objectPairs(obj: Record<string, unknown>): Array<[string, string]> {
  return Object.keys(obj)
    .sort()
    .map((k) => {
      try {
        return [k, primitiveString(obj[k])] as [string, string];
      } catch (err) {
        throw new Error(`object member "${k}": ${(err as Error).message}`, { cause: err });
      }
    });
}

function flattenPairs(pairs: Array<[string, string]>): string[] {
  const out: string[] = [];
  for (const [k, v] of pairs) out.push(k, v);
  return out;
}

function joinEscaped(parts: string[], sep: string, esc: Escaper): string {
  return parts.map(esc).join(sep);
}

function joinPairs(pairs: Array<[string, string]>, kvSep: string, pairSep: string, esc: Escaper): string {
  return pairs.map(([k, v]) => esc(k) + kvSep + esc(v)).join(pairSep);
}

const RESERVED_ESCAPES: Record<string, string> = {
  "%3A": ":", "%2F": "/", "%3F": "?", "%23": "#", "%5B": "[", "%5D": "]",
  "%40": "@", "%24": "$", "%26": "&", "%2B": "+", "%2C": ",", "%3B": ";", "%3D": "=",
};

/**
 * Percent-encodes one query-string piece with the encodeURIComponent byte
 * set (cross-SDK parity with the path escape); with allowReserved, RFC 3986
 * reserved characters additionally pass through unescaped, per the OAS
 * allowReserved rule. (The full RFC 3986 reserved set is gen-delims +
 * sub-delims; !, ', (, ), and * already pass through unescaped.)
 */
export function queryEscape(s: string, allowReserved: boolean): string {
  const escaped = encodeURIComponent(s);
  if (!allowReserved) return escaped;
  // Every alternative the regex admits has a table entry; the fallback is inert.
  return escaped.replace(/%(3A|2F|3F|23|5B|5D|40|24|26|2B|2C|3B|3D)/g, (m) => RESERVED_ESCAPES[m] ?? m);
}

/**
 * Percent-encodes one path parameter value with exactly JavaScript's
 * encodeURIComponent byte set, so the Go and TS invokers substitute
 * byte-identical URL path segments (Go's encodePathValue hand-rolls the
 * same set).
 */
export function encodePathValue(s: string): string {
  return encodeURIComponent(s);
}

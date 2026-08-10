import type { OpenAPIParameter, OpenAPIPathItem, OpenAPIOperation } from "./types.js";
import { mergeParameters } from "./util.js";
import { isJSONMediaType, normalizeMediaType, parseMediaType, type BodyPlan } from "./media.js";
import { hasMediaFidelity, hasRoutedInputs } from "./constants.js";

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
    if (!hasRoutedInputs(bindingSpec) && prev !== undefined && prev !== p.in) return p.name;
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
  bindingSpec = "openbindings.openapi@1",
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

    routeParameter(r, p, value, bindingSpec);
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
    } else if (plan.synthetic || plan.wholeObject) {
      if (name === SYNTHETIC_BODY_PROPERTY) {
        r.bodyValue = value;
        r.bodySet = true;
      } else {
        // A whole-value body carries only parameters and the synthetic
        // `body` property at this private boundary.
        unmatched.push(name);
      }
    } else {
      // Evaluation-free body passthrough: no schema evaluation participates
      // in routing; enforcing the body schema is the server's business.
      r.bodyFields[name] = value;
    }
  }
  if (unmatched.length > 0) {
    if (plan?.declared && (plan.synthetic || plan.wholeObject)) {
      throw new Error(
        `field(s) ${unmatched.join(", ")} match no declared parameter, and the declared request body uses whole-value carriage (its flattened contract carries only the synthetic "${SYNTHETIC_BODY_PROPERTY}" property)`,
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

/** Validates the OAS per-location style table without consulting a value. */
export function validateParameterSerialization(p: OpenAPIParameter): void {
  if (p.content && typeof p.content === "object") return;
  if (Object.hasOwn(p, "style") && (typeof p.style !== "string" || p.style === "")) {
    throw new Error(`parameter ${JSON.stringify(p.name)} declares an invalid style`);
  }
  if (Object.hasOwn(p, "explode") && typeof p.explode !== "boolean") {
    throw new Error(`parameter ${JSON.stringify(p.name)} declares a non-boolean explode`);
  }
  const { style, explode } = serializationMethod(p);
  const schema = asObject(p.schema);
  const types = schema ? parameterSchemaTypes(schema) : [];
  switch (p.in) {
    case "path":
      if (!["simple", "label", "matrix"].includes(style)) {
        throw new Error(`path parameter ${JSON.stringify(p.name)} declares unsupported style ${JSON.stringify(style)}`);
      }
      return;
    case "header":
      if (style !== "simple") throw new Error(`header parameter ${JSON.stringify(p.name)} requires simple style`);
      return;
    case "cookie":
      if (style !== "form") throw new Error(`cookie parameter ${JSON.stringify(p.name)} requires form style`);
      return;
    case "query":
      if (style === "form") return;
      if (style === "spaceDelimited" || style === "pipeDelimited") {
        if (explode || types.length === 0 || types.some((type) => type !== "array")) {
          throw new Error(
            `query parameter ${JSON.stringify(p.name)} uses ${style}, which is defined only for arrays with explode=false`,
          );
        }
        return;
      }
      if (style === "deepObject") {
        if (!explode || types.length === 0 || types.some((type) => type !== "object")) {
          throw new Error(
            `query parameter ${JSON.stringify(p.name)} uses deepObject, which is defined only for objects with explode=true`,
          );
        }
        return;
      }
      throw new Error(`query parameter ${JSON.stringify(p.name)} declares unsupported style ${JSON.stringify(style)}`);
    default:
      throw new Error(`parameter ${JSON.stringify(p.name)} declares unsupported location ${JSON.stringify(p.in)}`);
  }
}

function parameterSchemaTypes(schema: Record<string, unknown>): string[] {
  const result = new Set<string>();
  if (typeof schema.type === "string") result.add(schema.type);
  else if (Array.isArray(schema.type)) {
    for (const type of schema.type) if (typeof type === "string") result.add(type);
  }
  if (Array.isArray(schema.allOf)) {
    for (const member of schema.allOf) {
      const nested = asObject(member);
      if (nested) for (const type of parameterSchemaTypes(nested)) result.add(type);
    }
  }
  return [...result];
}

/** Serializes one populated parameter onto its wire location. */
export function routeParameter(
  r: RoutedInput,
  p: OpenAPIParameter,
  value: unknown,
  bindingSpec = "openbindings.openapi@1",
): void {
  const name = p.name ?? "";
  const allowReserved = p.allowReserved === true;
  const revision3 = hasMediaFidelity(bindingSpec);

  // A `content`-form parameter (schema-less, a single-entry content map)
  // serializes its value per its declared media type and rides its location
  // as that serialized string (OAPI-P-02).
  const content = p.content as Record<string, unknown> | undefined;
  if (content && Object.keys(content).length > 0) {
    const serialized = serializeParamContentValue(p, value, bindingSpec);
    switch (p.in) {
      case "path":
        r.resolvedPath = r.resolvedPath.replaceAll(
          `{${name}}`,
          serialized.bytes ? percentEncodeBytes(serialized.bytes, false) : encodePathValue(serialized.text, revision3),
        );
        break;
      case "query":
        r.queryUnits.push(
          queryEscape(name, false, revision3) + "=" + (
            serialized.bytes
              ? percentEncodeBytes(serialized.bytes, allowReserved)
              : queryEscape(serialized.text, allowReserved, revision3)
          ),
        );
        r.populated.query.add(name);
        break;
      case "header":
        r.headers.push([name, serialized.bytes ? bytesAsLatin1(serialized.bytes) : serialized.text]);
        r.populated.header.add(name.toLowerCase());
        break;
      case "cookie":
        r.cookieUnits.push(name + "=" + (serialized.bytes ? bytesAsLatin1(serialized.bytes) : serialized.text));
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
        expanded = serializePathValue(name, value, style, explode, revision3);
      } catch (e) {
        throw new Error(`path parameter "${name}": ${(e as Error).message}`, { cause: e });
      }
      r.resolvedPath = r.resolvedPath.replaceAll(`{${name}}`, expanded);
      break;
    }
    case "query": {
      let units: string[];
      try {
        units = serializeQueryValue(name, value, style, explode, allowReserved, revision3);
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
  return serializeParamContentValue(p, value, "openbindings.openapi@1").text;
}

function serializeParamContentValue(
  p: OpenAPIParameter,
  value: unknown,
  bindingSpec: string,
): { text: string; bytes?: Uint8Array<ArrayBuffer> } {
  const content = p.content as Record<string, unknown>;
  // The OAS requires exactly one entry; a malformed empty map yields the
  // zero-value key and falls to the loud no-carriage refusal below (Go
  // parity: the zero mediaKey takes the same path).
  const mediaKey = Object.keys(content)[0] ?? "";
  if (hasMediaFidelity(bindingSpec) && Object.keys(content).length !== 1) {
    throw new Error(`parameter ${JSON.stringify(p.name)} must declare exactly one content media type`);
  }
  const parsed = hasMediaFidelity(bindingSpec) ? parseMediaType(mediaKey, true) : null;
  const mt = parsed?.base ?? normalizeMediaType(mediaKey);
  let text: string;
  if (isJSONMediaType(mt)) {
    text = JSON.stringify(value);
  } else if (mt === "text/plain") {
    if (typeof value !== "string") {
      throw new Error(
        `parameter "${p.name}" declares content "${mediaKey}": the value must be a string, got ${typeof value}`,
      );
    }
    text = value;
  } else {
    throw new Error(
      `parameter "${p.name}" declares content "${mediaKey}": no parameter carriage is defined for that media type in openbindings.openapi@1`,
    );
  }
  if (parsed === null) return { text };
  return { text, bytes: encodeParameterContent(text, parsed.params["charset"]) };
}

function encodeParameterContent(text: string, charset: string | undefined): Uint8Array<ArrayBuffer> {
  switch (charset?.toLowerCase() ?? "utf-8") {
    case "utf-8":
      return new TextEncoder().encode(text);
    case "us-ascii": {
      const result = new Uint8Array(text.length);
      for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code > 0x7f) throw new Error("parameter content cannot represent its value as US-ASCII");
        result[index] = code;
      }
      return result;
    }
    case "iso-8859-1": {
      const result = new Uint8Array(text.length);
      for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code > 0xff) throw new Error("parameter content cannot represent its value as ISO-8859-1");
        result[index] = code;
      }
      return result;
    }
    default:
      throw new Error(`parameter content declares unsupported charset ${JSON.stringify(charset)}`);
  }
}

const RESERVED_BYTES = new Set(Array.from(":/?#[]@!$&'()*+,;=").map((char) => char.charCodeAt(0)));

function percentEncodeBytes(bytes: Uint8Array, allowReserved: boolean): string {
  let result = "";
  for (const byte of bytes) {
    const safe = (
      (byte >= 0x41 && byte <= 0x5a)
      || (byte >= 0x61 && byte <= 0x7a)
      || (byte >= 0x30 && byte <= 0x39)
      || [0x2d, 0x5f, 0x2e, 0x7e].includes(byte)
      || (allowReserved && RESERVED_BYTES.has(byte))
    );
    result += safe ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return result;
}

function bytesAsLatin1(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
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
  revision3 = false,
): string {
  const escape: Escaper = revision3 ? rfc3986Escape : encodePathValue;
  switch (style) {
    case "simple":
      return expandSimple(value, explode, escape);
    case "label":
      return expandLabel(value, explode, escape);
    case "matrix":
      return expandMatrix(name, value, explode, escape);
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
  revision3 = false,
  formBody = false,
): string[] {
  const n = queryEscape(name, false, revision3, formBody);
  const esc: Escaper = (s) => queryEscape(s, allowReserved, revision3, formBody);
  switch (style) {
    case "form":
      return expandFormPairs(n, value, explode, esc);
    case "spaceDelimited":
      if (explode) throw new Error("style spaceDelimited is defined only with explode=false");
      if (!asArray(value)) throw new Error("style spaceDelimited is defined for arrays only");
      return expandDelimited(n, value, false, "%20", esc);
    case "pipeDelimited":
      if (explode) throw new Error("style pipeDelimited is defined only with explode=false");
      if (!asArray(value)) throw new Error("style pipeDelimited is defined for arrays only");
      return expandDelimited(n, value, false, "|", esc);
    case "deepObject": {
      if (!explode) throw new Error("style deepObject is defined only with explode=true");
      const obj = asObject(value);
      if (!obj) {
        throw new Error(`style deepObject is defined for objects only, got ${typeof value}`);
      }
      return objectPairs(obj).map(([k, v]) => `${n}[${queryEscape(k, false, revision3, formBody)}]=${esc(v)}`);
    }
    default:
      throw new Error(`style "${style}" is not defined for query parameters`);
  }
}

/**
 * Expands one multipart property through the Encoding Object's RFC 6570
 * style/explode rules. Unlike query expansion, multipart names and values
 * are not URI percent-encoded: each expanded name becomes a part name and
 * its corresponding value becomes that part's body.
 */
export function serializeMultipartValue(
  name: string,
  value: unknown,
  style: string,
  explode: boolean,
): Array<[string, string]> {
  const array = asArray(value);
  const object = asObject(value);
  const values = (): string[] => arrayStrings(array ?? []);
  switch (style) {
    case "form": {
      if (array) return explode
        ? values().map((member) => [name, member])
        : [[name, values().join(",")]];
      if (object) return explode
        ? objectPairs(object)
        : [[name, flattenPairs(objectPairs(object)).join(",")]];
      return [[name, primitiveString(value)]];
    }
    case "spaceDelimited":
    case "pipeDelimited": {
      if (explode) throw new Error(`${style} style is defined only with explode=false`);
      if (!array) throw new Error(`${style} style is defined for arrays only`);
      const delimiter = style === "spaceDelimited" ? " " : "|";
      return [[name, values().join(delimiter)]];
    }
    case "deepObject": {
      if (!explode) throw new Error("style deepObject is defined only with explode=true");
      if (!object) {
        throw new Error(`style deepObject is defined for objects only, got ${typeof value}`);
      }
      return objectPairs(object).map(([key, member]) => [`${name}[${key}]`, member]);
    }
    default:
      throw new Error(`style "${style}" is not defined for multipart properties`);
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
 * spaceDelimited / pipeDelimited expansion internals. Public callers first
 * enforce the OAS table's defined cell: arrays with explode=false. Keeping
 * the helper general does not make the object/exploded cells admissible.
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
export function queryEscape(
  s: string,
  allowReserved: boolean,
  revision3 = false,
  formBody = false,
): string {
  if (revision3) return rfc3986Escape(s, allowReserved, formBody);
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
export function encodePathValue(s: string, revision3 = false): string {
  return revision3 ? rfc3986Escape(s) : encodeURIComponent(s);
}

function rfc3986Escape(s: string, allowReserved = false, formBody = false): string {
  const allowed = formBody
    ? new Set(Array.from(":/?@!$'()*,;").map((char) => char.charCodeAt(0)))
    : RESERVED_BYTES;
  const bytes = new TextEncoder().encode(s);
  let result = "";
  for (const byte of bytes) {
    const unreserved = (
      (byte >= 0x41 && byte <= 0x5a)
      || (byte >= 0x61 && byte <= 0x7a)
      || (byte >= 0x30 && byte <= 0x39)
      || [0x2d, 0x2e, 0x5f, 0x7e].includes(byte)
    );
    result += unreserved || (allowReserved && allowed.has(byte))
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return result;
}

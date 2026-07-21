import type {
  OpenAPIDocument,
  OpenAPIMediaType,
  OpenAPIOperation,
  OpenAPIResponse,
} from "./types.js";
import { asArray, asObject, primitiveString, serializeQueryValue } from "./params.js";

// This file implements §9.2 of openbindings.openapi@1 (OAPI-P-04): request
// media selection with its deterministic tiebreaks and pre-dispatch
// refusals, multipart part encoding (including the Base64 boundary encoding
// for binary-signaled parts), urlencoded field serialization, and the
// Accept-header membership rule — plus the §8 declared-media facts (success
// responses, streaming capability) the interaction shape is bounded by.
// Mirrors the Go SDK's formats/openapi/media.go.

/**
 * Lowercases a media type and strips its parameters: matching throughout
 * §9.2 compares type and subtype, ignoring parameters.
 */
export function normalizeMediaType(mt: string): string {
  const i = mt.indexOf(";");
  if (i >= 0) mt = mt.slice(0, i);
  return mt.trim().toLowerCase();
}

/** Reports a media range ("*" anywhere, e.g. application/star): ranges never participate in selection. */
export function isMediaRange(mt: string): boolean {
  return mt.includes("*");
}

/**
 * Reports application/json or a +json structured-suffix type. The argument
 * must already be normalized.
 */
export function isJSONMediaType(mt: string): boolean {
  return mt === "application/json" || mt.endsWith("+json");
}

/** Body families, in the §9.2 preference order. */
export const FAMILY_JSON = "json";
export const FAMILY_MULTIPART = "multipart";
export const FAMILY_URLENCODED = "urlencoded";
export const FAMILY_TEXT = "text";

/**
 * The pre-dispatch answer to the request-carriage questions: the selected
 * media type, its family, and the flatten mode its schema implies (§9.1:
 * object schemas flatten by property name; non-object schemas ride the
 * synthetic `body` property, unwrapped at the wire).
 */
export interface BodyPlan {
  declared: boolean;
  required: boolean;
  /** The declared content key, verbatim. */
  mediaKey: string;
  /** Normalized type/subtype (the request Content-Type). */
  mediaType: string;
  media: OpenAPIMediaType | null;
  family: string;
  synthetic: boolean;
  /** Declared top-level body property names (object mode). */
  props?: Set<string>;
}

const NO_BODY_PLAN: BodyPlan = {
  declared: false,
  required: false,
  mediaKey: "",
  mediaType: "",
  media: null,
  family: "",
  synthetic: false,
};

function hasRequestBody(op: OpenAPIOperation): boolean {
  return op.requestBody != null && typeof op.requestBody === "object";
}

/**
 * Selects the request media type from the operation's DECLARED
 * requestBody.content per OAPI-P-04's preference order: exact
 * application/json, then the lexicographically least +json type, then
 * multipart/form-data, then application/x-www-form-urlencoded, then
 * text/plain (whose string-value condition is checked after routing, when
 * the body value exists). An operation declaring only media types outside
 * these families is refused loudly before dispatch: its request carriage is
 * undefined in revision 1.
 */
export function planRequestBody(op: OpenAPIOperation): BodyPlan {
  if (!hasRequestBody(op)) return { ...NO_BODY_PLAN };
  const rb = op.requestBody!;
  const content = rb.content;
  if (!content || Object.keys(content).length === 0) {
    // A requestBody with no content declares no carriage; treat as no
    // declared body (degenerate artifact — the OAS requires content).
    return { ...NO_BODY_PLAN };
  }

  interface Candidate {
    key: string;
    normalized: string;
  }
  let exactJSON: Candidate | undefined;
  let multipartFD: Candidate | undefined;
  let urlEncoded: Candidate | undefined;
  let textPlain: Candidate | undefined;
  const plusJSON: Candidate[] = [];
  const declared: string[] = [];
  for (const key of Object.keys(content)) {
    const n = normalizeMediaType(key);
    declared.push(n);
    if (isMediaRange(n)) continue; // ranges never participate in selection
    const c: Candidate = { key, normalized: n };
    if (n === "application/json") exactJSON = c;
    else if (n.endsWith("+json")) plusJSON.push(c);
    else if (n === "multipart/form-data") multipartFD = c;
    else if (n === "application/x-www-form-urlencoded") urlEncoded = c;
    else if (n === "text/plain") textPlain = c;
  }

  let chosen: Candidate | undefined;
  let family: string;
  if (exactJSON) {
    chosen = exactJSON;
    family = FAMILY_JSON;
  } else if (plusJSON.length > 0) {
    plusJSON.sort((a, b) => (a.normalized < b.normalized ? -1 : 1));
    chosen = plusJSON[0];
    family = FAMILY_JSON;
  } else if (multipartFD) {
    chosen = multipartFD;
    family = FAMILY_MULTIPART;
  } else if (urlEncoded) {
    chosen = urlEncoded;
    family = FAMILY_URLENCODED;
  } else if (textPlain) {
    chosen = textPlain;
    family = FAMILY_TEXT;
  } else {
    declared.sort();
    throw new Error(
      `request body declares only media types outside the families openbindings.openapi@1 defines a request carriage for (declared: ${declared.join(", ")})`,
    );
  }

  const plan: BodyPlan = {
    declared: true,
    required: rb.required === true,
    mediaKey: chosen.key,
    mediaType: chosen.normalized,
    media: content[chosen.key] ?? null,
    family,
    synthetic: false,
  };

  // Flatten mode. text/plain bodies are scalar by nature: they always ride
  // the synthetic `body` property. JSON-family bodies are synthetic when
  // the declared schema's type is non-object (array or scalar, §9.1);
  // multipart and urlencoded bodies are field maps by construction.
  if (family === FAMILY_TEXT) {
    plan.synthetic = true;
  } else if (family === FAMILY_JSON) {
    const ty = mediaSchema(plan.media)?.type;
    if (typeof ty === "string" && ty !== "" && ty !== "object") {
      plan.synthetic = true;
    } else if (Array.isArray(ty) && ty.length > 0 && !ty.includes("object")) {
      plan.synthetic = true;
    }
  }
  if (!plan.synthetic) {
    plan.props = mediaSchemaProps(plan.media);
  }
  return plan;
}

function mediaSchema(media: OpenAPIMediaType | null): Record<string, unknown> | null {
  const schema = media?.schema;
  return schema && typeof schema === "object" ? schema : null;
}

/**
 * The selected media schema's declared top-level property names — the body
 * half of the flattened model's collision rule.
 */
function mediaSchemaProps(media: OpenAPIMediaType | null): Set<string> | undefined {
  const props = mediaSchema(media)?.properties;
  if (!props || typeof props !== "object") return undefined;
  const names = Object.keys(props);
  if (names.length === 0) return undefined;
  return new Set(names);
}

/** A routed input's body halves, as buildRequestBody consumes them. */
export interface RoutedBody {
  bodyFields: Record<string, unknown>;
  bodyValue: unknown;
  bodySet: boolean;
}

/** The wire body for one dispatch: undefined body + empty content type means no body is sent. */
export interface WireBody {
  body: BodyInit | undefined;
  /** The request Content-Type; empty when the runtime sets it (multipart boundary) or no body rides. */
  contentType: string;
}

/**
 * Produces the wire body for the selected media type. An undefined body
 * with an empty content type means no body is sent (§9.1's remaining-body
 * rule: with a JSON-family selection and every input field consumed by
 * parameters, the body is {} if the request body is declared required and
 * omitted otherwise).
 */
export function buildRequestBody(
  doc: OpenAPIDocument,
  plan: BodyPlan | null,
  routed: RoutedBody,
): WireBody {
  if (!plan?.declared) return { body: undefined, contentType: "" };
  switch (plan.family) {
    case FAMILY_JSON: {
      if (plan.synthetic) {
        if (!routed.bodySet) {
          // A supplied input missing the synthetic body member is sent
          // as-is (the server's declared validation is the authority): no
          // body rides the wire.
          return { body: undefined, contentType: "" };
        }
        return { body: JSON.stringify(routed.bodyValue ?? null), contentType: plan.mediaType };
      }
      if (Object.keys(routed.bodyFields).length === 0) {
        if (plan.required) return { body: "{}", contentType: plan.mediaType };
        return { body: undefined, contentType: "" };
      }
      return { body: JSON.stringify(routed.bodyFields), contentType: plan.mediaType };
    }
    case FAMILY_MULTIPART: {
      if (Object.keys(routed.bodyFields).length === 0 && !plan.required) {
        return { body: undefined, contentType: "" };
      }
      // The runtime stamps the multipart boundary onto Content-Type itself.
      return { body: buildMultipartBody(doc, plan.media, routed.bodyFields), contentType: "" };
    }
    case FAMILY_URLENCODED: {
      if (Object.keys(routed.bodyFields).length === 0 && !plan.required) {
        return { body: undefined, contentType: "" };
      }
      return {
        body: buildURLEncodedBody(plan.media, routed.bodyFields),
        contentType: plan.mediaType,
      };
    }
    case FAMILY_TEXT: {
      if (!routed.bodySet) return { body: undefined, contentType: "" };
      if (typeof routed.bodyValue !== "string") {
        // The selection condition failed: text/plain is selected only when
        // the body value is a string (OAPI-P-04).
        throw new Error(
          `request media text/plain was selected but the body value is ${typeof routed.bodyValue}, not a string`,
        );
      }
      return { body: routed.bodyValue, contentType: plan.mediaType };
    }
  }
  throw new Error(`unknown body family "${plan.family}"`);
}

// ---------------------------------------------------------------------------
// Multipart (OAPI-P-04's part-encoding rules)
// ---------------------------------------------------------------------------

function isOpenAPI30(doc: OpenAPIDocument): boolean {
  return typeof doc.openapi === "string" && doc.openapi.startsWith("3.0");
}

/**
 * Encodes body fields as multipart/form-data. A part is binary-signaled per
 * the artifact's edition — 3.0.x by `format: binary`, 3.1.x by a string
 * schema carrying contentMediaType/contentEncoding — and a binary-signaled
 * part's bytes come from the caller's string value: decoded per the
 * schema's declared contentEncoding where one is declared, and by Base64
 * where the artifact signals binary without declaring an encoding (the
 * specification's boundary encoding for bytes). Parts that are not
 * binary-signaled serialize per the artifact's `encoding` object where
 * present, else per the OAS's per-type part defaults (objects as
 * application/json parts, primitives as text fields). Nothing here is
 * decided by the value's bytes; the artifact's declarations decide. Fields
 * are written in sorted order for a deterministic body.
 */
export function buildMultipartBody(
  doc: OpenAPIDocument,
  media: OpenAPIMediaType | null,
  fields: Record<string, unknown>,
): FormData {
  const fd = new FormData();
  const is30 = isOpenAPI30(doc);
  const schema = mediaSchema(media);
  const properties = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const encoding = (media?.encoding ?? {}) as Record<string, Record<string, unknown>>;

  for (const name of Object.keys(fields).sort()) {
    const value = fields[name];
    const propSchema = asObject(properties[name]);
    const enc = asObject(encoding[name]);

    // A declared array expands into repeated parts of the same name, each
    // element encoded per the items schema (the multipart way to carry
    // arrays — including arrays of files).
    if (propSchema && schemaTypeIs(propSchema, "array")) {
      const arr = asArray(value);
      if (arr) {
        const items = asObject(propSchema.items);
        for (const elem of arr) {
          writeMultipartPart(fd, name, elem, items, enc, is30);
        }
        continue;
      }
    }
    writeMultipartPart(fd, name, value, propSchema, enc, is30);
  }
  return fd;
}

function schemaTypeIs(schema: Record<string, unknown>, want: string): boolean {
  const ty = schema.type;
  if (typeof ty === "string") return ty === want;
  if (Array.isArray(ty)) return ty.includes(want);
  return false;
}

function writeMultipartPart(
  fd: FormData,
  name: string,
  value: unknown,
  schema: Record<string, unknown> | null,
  enc: Record<string, unknown> | null,
  is30: boolean,
): void {
  const encContentType = typeof enc?.contentType === "string" ? enc.contentType : "";

  if (binarySignaled(schema, is30)) {
    // An in-process Blob passes through raw (it cannot have arrived as
    // JSON) — the convenience counterpart of Go's []byte passthrough.
    const ct =
      encContentType ||
      (typeof schema?.contentMediaType === "string" ? schema.contentMediaType : "") ||
      "application/octet-stream";
    if (value instanceof Blob) {
      fd.append(name, value.type ? value : new Blob([value], { type: ct }), name);
      return;
    }
    const data = binaryPartBytes(name, value, declaredContentEncoding(schema, is30));
    fd.append(name, new Blob([data as BlobPart], { type: ct }), name);
    return;
  }

  // The encoding object's contentType, where declared, decides the part's
  // serialization; else the OAS per-type part defaults apply.
  if (encContentType) {
    const ct = normalizeMediaType(encContentType);
    let body: string;
    if (isJSONMediaType(ct)) {
      body = JSON.stringify(value ?? null);
    } else if (typeof value === "string") {
      body = value;
    } else {
      try {
        body = primitiveString(value);
      } catch {
        body = JSON.stringify(value ?? null);
      }
    }
    fd.append(name, new Blob([body], { type: encContentType }), name);
    return;
  }

  // Per-type defaults: objects (and undeclared complex values) ride as
  // application/json parts; primitives as plain form fields.
  if (isComplexPartValue(value, schema)) {
    fd.append(name, new Blob([JSON.stringify(value ?? null)], { type: "application/json" }), name);
    return;
  }
  fd.append(name, primitiveString(value));
}

/**
 * Decides object-vs-primitive part encoding: by the declared schema type
 * where one exists, by the JSON value's own shape for undeclared
 * passthrough fields (a declaration-free field has no artifact answer; a
 * JSON value's TYPE is structure, not byte-sniffing).
 */
function isComplexPartValue(value: unknown, schema: Record<string, unknown> | null): boolean {
  const ty = schema?.type;
  if (typeof ty === "string" && ty !== "") {
    return ty === "object" || ty === "array";
  }
  if (Array.isArray(ty) && ty.length > 0) {
    return ty.includes("object") || ty.includes("array");
  }
  return asObject(value) !== null || asArray(value) !== null;
}

/**
 * The edition rule: 3.0.x signals binary with `format: binary`; 3.1.x with
 * a string schema carrying contentMediaType or contentEncoding.
 */
export function binarySignaled(schema: Record<string, unknown> | null, is30: boolean): boolean {
  if (!schema) return false;
  if (is30) return schema.format === "binary";
  if (!schemaTypeIs(schema, "string")) return false;
  return (
    (typeof schema.contentMediaType === "string" && schema.contentMediaType !== "") ||
    (typeof schema.contentEncoding === "string" && schema.contentEncoding !== "")
  );
}

/**
 * The 3.1 schema's declared contentEncoding (3.0 has no equivalent
 * keyword; its binary signal carries no encoding).
 */
function declaredContentEncoding(schema: Record<string, unknown> | null, is30: boolean): string {
  if (is30) return "";
  return typeof schema?.contentEncoding === "string" ? schema.contentEncoding : "";
}

/**
 * Decodes a binary-signaled part's bytes from the caller's string value:
 * per the declared contentEncoding when one is declared, Base64 otherwise
 * (the boundary encoding for bytes — the operation value domain is JSON).
 * An in-process Uint8Array passes through raw (it cannot have arrived as
 * JSON).
 */
export function binaryPartBytes(
  name: string,
  value: unknown,
  contentEncoding: string,
): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value !== "string") {
    throw new Error(
      `binary part "${name}": the value must be a string carrying the encoded bytes, got ${typeof value}`,
    );
  }
  switch (contentEncoding.toLowerCase()) {
    case "":
    case "base64":
      return decodeBase64(name, value, "base64");
    case "base64url":
      return decodeBase64(name, value.replace(/-/g, "+").replace(/_/g, "/"), "base64url");
    case "base16":
    case "hex": {
      if (!/^([0-9a-fA-F]{2})*$/.test(value)) {
        throw new Error(`binary part "${name}": invalid base16`);
      }
      const out = new Uint8Array(value.length / 2);
      for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
      }
      return out;
    }
    case "base32":
      return decodeBase32(name, value);
    case "quoted-printable":
      return decodeQuotedPrintable(name, value);
    case "binary":
    case "7bit":
    case "8bit":
      return new TextEncoder().encode(value);
    default:
      throw new Error(`binary part "${name}": unsupported contentEncoding "${contentEncoding}"`);
  }
}

function decodeBase64(name: string, s: string, label: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(s);
  } catch {
    throw new Error(`binary part "${name}": invalid ${label}`);
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function decodeBase32(name: string, s: string): Uint8Array {
  const stripped = s.replace(/=+$/, "");
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const ch of stripped) {
    const idx = BASE32_ALPHABET.indexOf(ch.toUpperCase());
    if (idx < 0) throw new Error(`binary part "${name}": invalid base32`);
    acc = (acc << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function decodeQuotedPrintable(name: string, s: string): Uint8Array {
  const withoutSoftBreaks = s.replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < withoutSoftBreaks.length; i++) {
    const c = withoutSoftBreaks[i];
    if (c === "=") {
      const hex = withoutSoftBreaks.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        throw new Error(`binary part "${name}": invalid quoted-printable`);
      }
      out.push(parseInt(hex, 16));
      i += 2;
    } else {
      const code = c.charCodeAt(0);
      if (code > 0xff) {
        throw new Error(`binary part "${name}": invalid quoted-printable`);
      }
      out.push(code);
    }
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// application/x-www-form-urlencoded
// ---------------------------------------------------------------------------

/**
 * Serializes body fields per the OAS `encoding` rules: each field's
 * style/explode/allowReserved come from the media type's encoding object
 * where present, defaulting to form/explode=true. Fields are serialized
 * with the same expansions as query parameters and joined in sorted-name
 * order for a deterministic body.
 */
export function buildURLEncodedBody(
  media: OpenAPIMediaType | null,
  fields: Record<string, unknown>,
): string {
  const encoding = (media?.encoding ?? {}) as Record<string, Record<string, unknown>>;
  const units: string[] = [];
  for (const name of Object.keys(fields).sort()) {
    let style = "form";
    let explode: boolean | undefined;
    let allowReserved = false;
    const enc = asObject(encoding[name]);
    if (enc) {
      if (typeof enc.style === "string" && enc.style) style = enc.style;
      if (typeof enc.explode === "boolean") explode = enc.explode;
      allowReserved = enc.allowReserved === true;
    }
    try {
      units.push(...serializeQueryValue(name, fields[name], style, explode ?? style === "form", allowReserved));
    } catch (e) {
      throw new Error(`form field "${name}": ${(e as Error).message}`, { cause: e });
    }
  }
  return units.join("&");
}

// ---------------------------------------------------------------------------
// Success responses, Accept, streaming capability (§8, §9.2)
// ---------------------------------------------------------------------------

/**
 * The §8 definition of a success response entry: a 2xx status literal or
 * the `2XX` range. The `default` entry never participates in shape or
 * media determination.
 */
export function isSuccessResponseKey(key: string): boolean {
  if (key === "2XX") return true;
  return /^2[0-9][0-9]$/.test(key);
}

/**
 * The declared CONCRETE media types of the operation's success responses,
 * normalized, deduplicated, and sorted (membership is normative, ordering
 * is not). Media ranges are excluded: they are not concrete.
 */
export function successMediaTypes(op: OpenAPIOperation | null | undefined): string[] {
  if (!op?.responses) return [];
  const seen = new Set<string>();
  for (const [key, resp] of Object.entries(op.responses)) {
    if (!isSuccessResponseKey(key)) continue;
    const content = (resp as OpenAPIResponse | undefined)?.content;
    if (!content) continue;
    for (const mt of Object.keys(content)) {
      const n = normalizeMediaType(mt);
      if (n === "" || isMediaRange(n)) continue;
      seen.add(n);
    }
  }
  return [...seen].sort();
}

/**
 * Advertises the declared concrete media types of the operation's success
 * responses; absent any declaration, application/json (§9.2).
 */
export function acceptHeader(op: OpenAPIOperation): string {
  const types = successMediaTypes(op);
  if (types.length === 0) return "application/json";
  return types.join(", ");
}

/**
 * The §8 static capability: an operation is streaming-capable iff
 * text/event-stream appears among the declared media types of its success
 * responses.
 */
export function isStreamingCapable(op: OpenAPIOperation): boolean {
  return successMediaTypes(op).includes("text/event-stream");
}

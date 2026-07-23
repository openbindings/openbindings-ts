import type {
  OpenAPIDocument,
  OpenAPIMediaType,
  OpenAPIOperation,
  OpenAPIResponse,
} from "./types.js";
import { asArray, asObject, primitiveString, serializeQueryValue } from "./params.js";
import { bodySchemaFlattens } from "./util.js";

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

export interface ParsedMediaType {
  base: string;
  params: Record<string, string>;
  canonical: string;
  identity: string;
}

/** Parses the concrete media-type identity used for declaration collision and matching. */
export function parseMediaType(raw: string): ParsedMediaType {
  const parts = splitMediaType(raw);
  const base = (parts.shift() ?? "").trim().toLowerCase();
  if (!base || !base.includes("/") || isMediaRange(base)) {
    throw new Error(`media type ${JSON.stringify(raw)} is not concrete`);
  }
  const params: Record<string, string> = {};
  for (const part of parts) {
    const equals = part.indexOf("=");
    if (equals <= 0) throw new Error(`invalid media-type parameter in ${JSON.stringify(raw)}`);
    const name = part.slice(0, equals).trim().toLowerCase();
    if (name in params) throw new Error(`duplicate media-type parameter ${JSON.stringify(name)}`);
    params[name] = unquoteParameter(part.slice(equals + 1).trim());
  }
  const keys = Object.keys(params).sort();
  const identity = [base, ...keys.map((key) => `${key}=${params[key]}`)].join("\u0000");
  const canonical = base + keys.map((key) => `; ${key}=${formatParameter(params[key] ?? "")}`).join("");
  return { base, params, canonical, identity };
}

function splitMediaType(raw: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (escaped) escaped = false;
    else if (char === "\\" && quoted) escaped = true;
    else if (char === '"') quoted = !quoted;
    else if (char === ";" && !quoted) {
      parts.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  if (quoted) throw new Error(`unterminated quoted media-type parameter in ${JSON.stringify(raw)}`);
  parts.push(raw.slice(start));
  return parts;
}

function unquoteParameter(value: string): string {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"') || value.length < 2) throw new Error("invalid quoted parameter");
  return value.slice(1, -1).replace(/\\([\\"])/g, "$1");
}

function formatParameter(value: string): string {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)
    ? value
    : `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Supported request-body families. The artifact gives them no preference order. */
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
  /** Canonical parsed declaration, including identity-affecting parameters. */
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
 * §9.2's degenerate media/schema combination refusal (OAPI-P-04): the
 * selected request media type has no OAS-defined wire form for the
 * declared body schema. A distinct class so synthesis (synthesize.ts) can
 * surface the same fact as the openapi.media_schema_mismatch warning
 * without re-deriving the selection. Mirrors the Go SDK's
 * degenerateMediaError.
 */
export class DegenerateMediaError extends Error {}

/**
 * Compatibility convenience for callers that need one SDK-local candidate.
 * Invocation uses planRequestBodies so the binding layer preserves every
 * artifact-permitted alternative until configuration or admissibility chooses.
 */
export function planRequestBody(op: OpenAPIOperation): BodyPlan {
  return planRequestBodies(op)[0] ?? { ...NO_BODY_PLAN };
}

/** Preserves all concrete supported request candidates without binding-spec preference. */
export function planRequestBodies(op: OpenAPIOperation): BodyPlan[] {
  if (!hasRequestBody(op)) return [];
  const rb = op.requestBody!;
  const content = rb.content;
  if (!content || Object.keys(content).length === 0) return [];

  interface Candidate {
    key: string;
    parsed: ParsedMediaType;
    family: string;
  }
  const candidates: Candidate[] = [];
  const declared: string[] = [];
  const identities = new Map<string, string>();
  for (const key of Object.keys(content)) {
    let parsed: ParsedMediaType;
    try {
      parsed = parseMediaType(key);
    } catch {
      declared.push(key);
      continue;
    }
    declared.push(parsed.canonical);
    const previous = identities.get(parsed.identity);
    if (previous !== undefined) {
      throw new Error(
        `request content declarations ${JSON.stringify(previous)} and ${JSON.stringify(key)} denote the same parsed media type (OAPI-P-04 normalized collision)`,
      );
    }
    identities.set(parsed.identity, key);
    let family = "";
    if (isJSONMediaType(parsed.base)) family = FAMILY_JSON;
    else if (parsed.base === "multipart/form-data") family = FAMILY_MULTIPART;
    else if (parsed.base === "application/x-www-form-urlencoded") family = FAMILY_URLENCODED;
    else if (parsed.base === "text/plain") family = FAMILY_TEXT;
    if (family) candidates.push({ key, parsed, family });
  }
  if (candidates.length === 0) {
    declared.sort();
    throw new Error(
      `request body declares only media types outside the families openbindings.openapi@1 defines a request carriage for (declared: ${declared.join(", ")})`,
    );
  }
  candidates.sort((a, b) => a.parsed.identity.localeCompare(b.parsed.identity));
  const plans: BodyPlan[] = [];
  const rejected: string[] = [];
  for (const candidate of candidates) {
    try {
      plans.push(buildBodyPlan(rb.required === true, content, candidate));
    } catch (error: unknown) {
      rejected.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (plans.length === 0) throw new DegenerateMediaError(rejected.join("; "));
  return plans;
}

function buildBodyPlan(
  required: boolean,
  content: Record<string, OpenAPIMediaType>,
  candidate: { key: string; parsed: ParsedMediaType; family: string },
): BodyPlan {
  const plan: BodyPlan = {
    declared: true,
    required,
    mediaKey: candidate.key,
    mediaType: candidate.parsed.canonical,
    media: content[candidate.key] ?? null,
    family: candidate.family,
    synthetic: false,
  };
  const schema = mediaSchema(plan.media);
  const shape = resolvedBodyShape(schema, new Set());
  if (candidate.family === FAMILY_JSON) {
    plan.synthetic = schema !== null && !shape.object;
  } else if (candidate.family === FAMILY_MULTIPART || candidate.family === FAMILY_URLENCODED) {
    if (schema !== null && !shape.object) {
      throw new Error(`request media candidate ${plan.mediaType} has a non-object body schema and is inadmissible`);
    }
  } else if (candidate.family === FAMILY_TEXT) {
    if (schema !== null && shape.object) {
      throw new Error("request media candidate text/plain has an object body schema and is inadmissible");
    }
    plan.synthetic = true;
  }
  if (!plan.synthetic && shape.props.size > 0) plan.props = shape.props;
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
function resolvedBodyShape(
  schema: Record<string, unknown> | null,
  seen: Set<Record<string, unknown>>,
): { object: boolean; props: Set<string> } {
  if (schema === null) return { object: true, props: new Set() };
  if (seen.has(schema)) return { object: false, props: new Set() };
  seen.add(schema);
  try {
    if (
      Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf) || schema.not !== undefined ||
      schema.if !== undefined || schema.then !== undefined || schema.else !== undefined
    ) {
      throw new Error(
        "conditional/combinatorial request schema has no single declaration-defined flattened surface in openbindings.openapi@1 revision 1",
      );
    }
    const props = new Set<string>();
    const ownProps = schema.properties;
    if (ownProps && typeof ownProps === "object" && !Array.isArray(ownProps)) {
      for (const name of Object.keys(ownProps)) props.add(name);
    }
    let object = bodySchemaFlattens(schema);
    if (Array.isArray(schema.allOf)) {
      for (const member of schema.allOf) {
        if (!member || typeof member !== "object" || Array.isArray(member)) continue;
        const nested = resolvedBodyShape(member as Record<string, unknown>, seen);
        object ||= nested.object;
        for (const name of nested.props) props.add(name);
      }
    }
    return { object, props };
  } finally {
    seen.delete(schema);
  }
}

export function candidateCollides(params: Array<{ name?: string }>, plan: BodyPlan): boolean {
  return params.some((parameter) => {
    const name = parameter.name ?? "";
    return (plan.synthetic && name === "body") || (!plan.synthetic && plan.props?.has(name) === true);
  });
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
    const c = withoutSoftBreaks.charAt(i);
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
 * A literal 2xx entry or `2XX` is intrinsically successful. `default` also
 * participates in the possible success surface because it can govern a 2xx
 * status that has no more-specific declaration.
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
  const hasRange = Object.hasOwn(op.responses, "2XX");
  const exactSuccesses = new Set(
    Object.keys(op.responses).filter((key) => /^2[0-9][0-9]$/.test(key)),
  );
  for (const [key, resp] of Object.entries(op.responses)) {
    const defaultCanGovernSuccess = key === "default" && !hasRange && exactSuccesses.size < 100;
    if (!isSuccessResponseKey(key) && !defaultCanGovernSuccess) continue;
    const content = (resp as OpenAPIResponse | undefined)?.content;
    if (!content) continue;
    for (const mt of Object.keys(content)) {
      try {
        seen.add(parseMediaType(mt).canonical);
      } catch {
        // A non-concrete media range cannot be advertised as one concrete
        // representation. Malformed keys are handled when they govern.
      }
    }
  }
  return [...seen].sort();
}

/**
 * Advertises the declared concrete media types of the operation's success
 * responses. No declaration means no invented Accept preference.
 */
export function acceptHeader(op: OpenAPIOperation): string {
  const types = successMediaTypes(op);
  return types.join(", ");
}

/** The response declaration governing one actual status: exact, range, then default. */
export function governingResponse(
  op: OpenAPIOperation,
  status: number,
): { key: string; response: OpenAPIResponse } | null {
  const responses = op.responses ?? {};
  const exact = String(status);
  const range = `${Math.floor(status / 100)}XX`;
  for (const key of [exact, range, "default"]) {
    const response = responses[key] as OpenAPIResponse | undefined;
    if (response && typeof response === "object") return { key, response };
  }
  return null;
}

/**
 * Selects the most-specific declared media identity compatible with the
 * actual Content-Type. A declaration's parameters must be a subset of the
 * actual parameters; equally specific alternatives are ambiguous.
 */
export function governingResponseMedia(
  response: OpenAPIResponse,
  actualContentType: string | null,
): string | null {
  const content = response.content ?? {};
  if (Object.keys(content).length === 0) return null;
  if (!actualContentType) {
    throw new Error("response declaration has content alternatives but the response omits Content-Type");
  }
  const actual = parseMediaType(actualContentType);
  const matches: Array<{ media: ParsedMediaType; specificity: number }> = [];
  for (const key of Object.keys(content)) {
    const declared = parseMediaType(key);
    if (declared.base !== actual.base) continue;
    if (Object.entries(declared.params).every(([name, value]) => actual.params[name] === value)) {
      matches.push({ media: declared, specificity: Object.keys(declared.params).length });
    }
  }
  if (matches.length === 0) {
    throw new Error(
      `response Content-Type ${JSON.stringify(actualContentType)} matches no media declaration in the governing Response Object`,
    );
  }
  matches.sort((a, b) => b.specificity - a.specificity || a.media.identity.localeCompare(b.media.identity));
  if (matches.length > 1 && matches[0]?.specificity === matches[1]?.specificity) {
    throw new Error(
      `response Content-Type ${JSON.stringify(actualContentType)} ambiguously matches equally specific media declarations`,
    );
  }
  return matches[0]?.media.canonical ?? null;
}

/**
 * The §8 static capability: an operation is streaming-capable iff
 * text/event-stream appears among the declared media types of its success
 * responses.
 */
export function isStreamingCapable(op: OpenAPIOperation): boolean {
  return successMediaTypes(op).includes("text/event-stream");
}

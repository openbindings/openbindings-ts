import type {
  OpenAPIDocument,
  OpenAPIMediaType,
  OpenAPIOperation,
  OpenAPIResponse,
} from "./types.js";
import {
  asArray,
  asObject,
  primitiveString,
  serializeMultipartValue,
  serializeQueryValue,
} from "./params.js";
import { bodySchemaFlattens } from "./util.js";
import {
  hasDynamicObjectCarriage,
  hasMediaFidelity,
  hasSchemaOmittedOAS30ByteCarriage,
  hasWholeJSONCarriage,
} from "./constants.js";

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

/** Revision-3 grammar classification: `*` is otherwise a legal tchar. */
function isStructuralMediaRange(type: string, subtype: string): boolean {
  return subtype === "*" || type === "*";
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
  /** Parsed values preserved for wire rendering, separate from semantic comparison values. */
  renderedParams: Record<string, string>;
  canonical: string;
  identity: string;
}

export interface ParsedMediaRange extends ParsedMediaType {
  specificity: 0 | 1;
}

const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Parses the concrete media-type identity used for declaration collision and matching. */
export function parseMediaType(raw: string, semanticParameters = false): ParsedMediaType {
  const parts = splitMediaType(raw);
  const base = (parts.shift() ?? "").trim().toLowerCase();
  const baseParts = base.split("/");
  const validBase = semanticParameters
    ? baseParts.length === 2
      && HTTP_TOKEN.test(baseParts[0] ?? "")
      && HTTP_TOKEN.test(baseParts[1] ?? "")
      && !isStructuralMediaRange(baseParts[0] ?? "", baseParts[1] ?? "")
    : Boolean(base && base.includes("/") && !isMediaRange(base));
  if (!validBase) {
    throw new Error(`media type ${JSON.stringify(raw)} is not concrete`);
  }
  const params: Record<string, string> = semanticParameters ? Object.create(null) as Record<string, string> : {};
  const rendered: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const part of parts) {
    // RFC 9110's parameter production permits empty list elements. Keep
    // compatibility revisions immutable, but accept trailing/repeated
    // semicolons in revision 3 while retaining strict grammar for every
    // non-empty parameter.
    if (semanticParameters && part.trim() === "") continue;
    const equals = part.indexOf("=");
    if (equals <= 0) throw new Error(`invalid media-type parameter in ${JSON.stringify(raw)}`);
    const namePart = part.slice(0, equals);
    const rawName = semanticParameters ? namePart.replace(/^[ \t]*/, "") : namePart.trimStart();
    const rawValue = part.slice(equals + 1);
    if (semanticParameters && (rawName !== rawName.trimEnd() || /^[ \t]/.test(rawValue))) {
      throw new Error(`invalid whitespace around media-type parameter '=' in ${JSON.stringify(raw)}`);
    }
    const name = rawName.trim().toLowerCase();
    if (semanticParameters && !HTTP_TOKEN.test(name)) {
      throw new Error(`invalid media-type parameter name in ${JSON.stringify(raw)}`);
    }
    if ((semanticParameters ? Object.hasOwn(params, name) : name in params)) {
      throw new Error(`duplicate media-type parameter ${JSON.stringify(name)}`);
    }
    const value = unquoteParameter(
      semanticParameters ? rawValue.replace(/[ \t]+$/, "") : rawValue.trim(),
      semanticParameters,
    );
    rendered[name] = value;
    params[name] = semanticParameters ? normalizeMediaParameterValue(name, value) : value;
  }
  const keys = Object.keys(params).sort();
  const identity = [base, ...keys.map((key) => `${key}=${params[key]}`)].join("\u0000");
  const canonical = base + keys.map((key) => `; ${key}=${formatParameter(rendered[key] ?? "")}`).join("");
  return { base, params, renderedParams: rendered, canonical, identity };
}

/** Parses an OpenAPI request content media range accepted by revision 3. */
export function parseMediaRange(raw: string, semanticParameters = false): ParsedMediaRange {
  const parts = splitMediaType(raw);
  const base = (parts.shift() ?? "").trim().toLowerCase();
  const baseParts = base.split("/");
  const rangeType = baseParts[0] ?? "";
  const rangeSubtype = baseParts[1] ?? "";
  const valid = semanticParameters
    ? baseParts.length === 2
      && rangeSubtype === "*"
      && HTTP_TOKEN.test(rangeType)
      && (rangeType !== "*" || base === "*/*")
    : base === "*/*" || /^[^*/\s]+\/\*$/.test(base);
  if (!valid) throw new Error(`media type ${JSON.stringify(raw)} is not a supported media range`);
  const params: Record<string, string> = semanticParameters ? Object.create(null) as Record<string, string> : {};
  const rendered: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const part of parts) {
    if (semanticParameters && part.trim() === "") continue;
    const equals = part.indexOf("=");
    if (equals <= 0) throw new Error(`invalid media-type parameter in ${JSON.stringify(raw)}`);
    const namePart = part.slice(0, equals);
    const rawName = semanticParameters ? namePart.replace(/^[ \t]*/, "") : namePart.trimStart();
    const rawValue = part.slice(equals + 1);
    if (semanticParameters && (rawName !== rawName.trimEnd() || /^[ \t]/.test(rawValue))) {
      throw new Error(`invalid whitespace around media-type parameter '=' in ${JSON.stringify(raw)}`);
    }
    const name = rawName.trim().toLowerCase();
    if (semanticParameters && !HTTP_TOKEN.test(name)) {
      throw new Error(`invalid media-type parameter name in ${JSON.stringify(raw)}`);
    }
    if ((semanticParameters ? Object.hasOwn(params, name) : name in params)) {
      throw new Error(`duplicate media-type parameter ${JSON.stringify(name)}`);
    }
    const value = unquoteParameter(
      semanticParameters ? rawValue.replace(/[ \t]+$/, "") : rawValue.trim(),
      semanticParameters,
    );
    rendered[name] = value;
    params[name] = semanticParameters ? normalizeMediaParameterValue(name, value) : value;
  }
  const keys = Object.keys(params).sort();
  const identity = [base, ...keys.map((key) => `${key}=${params[key]}`)].join("\u0000");
  const canonical = base + keys.map((key) => `; ${key}=${formatParameter(rendered[key] ?? "")}`).join("");
  return { base, params, renderedParams: rendered, canonical, identity, specificity: base === "*/*" ? 0 : 1 };
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

function unquoteParameter(value: string, fullQuotedPair = false): string {
  if (!value.startsWith('"')) {
    if (fullQuotedPair && !HTTP_TOKEN.test(value)) throw new Error("invalid unquoted media-type parameter value");
    return value;
  }
  if (!value.endsWith('"') || value.length < 2) throw new Error("invalid quoted parameter");
  if (fullQuotedPair) {
    const inner = value.slice(1, -1);
    for (let i = 0; i < inner.length; i++) {
      const code = inner.charCodeAt(i);
      if (inner[i] === "\\") {
        i++;
        if (i >= inner.length) throw new Error("invalid quoted-pair in media-type parameter");
        const escaped = inner.charCodeAt(i);
        if (!(escaped === 9 || escaped === 32 || (escaped >= 0x21 && escaped <= 0x7e) || (escaped >= 0x80 && escaped <= 0xff))) {
          throw new Error("invalid quoted-pair in media-type parameter");
        }
      } else if (!(code === 9 || code === 32 || code === 0x21 || (code >= 0x23 && code <= 0x5b) || (code >= 0x5d && code <= 0x7e) || (code >= 0x80 && code <= 0xff))) {
        throw new Error("invalid quoted-string in media-type parameter");
      }
    }
  }
  return value.slice(1, -1).replace(fullQuotedPair ? /\\(.)/g : /\\([\\"])/g, "$1");
}

function formatParameter(value: string): string {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)
    ? value
    : `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Extensible semantic-normalization seam for registered media parameters.
 * Unknown parameters intentionally retain bytewise comparison. Charset is
 * case-insensitive; a syntactically valid nested media `type` parameter is
 * compared by that media type's own semantic identity.
 */
function normalizeMediaParameterValue(name: string, value: string): string {
  if (name === "charset") return value.toLowerCase();
  if (name === "type") {
    try { return parseMediaType(value, true).identity; } catch { /* unknown/non-media value stays bytewise */ }
  }
  return value;
}

/** Supported request-body families. The artifact gives them no preference order. */
export const FAMILY_JSON = "json";
export const FAMILY_MULTIPART = "multipart";
export const FAMILY_URLENCODED = "urlencoded";
export const FAMILY_TEXT = "text";
export const FAMILY_RAW = "raw";

type MediaSchema = Record<string, unknown> | boolean | null;

export interface RequestPlanningOptions {
  /** Defaults to immutable revision 2 so direct helper callers retain prior behavior. */
  bindingSpec?: string;
  openapiVersion?: string;
  /** Invocation-only: retain valid but unsupported declarations so selection ranks them before refusal. */
  inventoryUnsupported?: boolean;
}

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
  /** True when a body rides as one complete application value under a public payload field. */
  wholeObject?: boolean;
  /** True while a revision-3 media range awaits a concrete requestMedia choice. */
  range?: boolean;
  /** True when the OBI boundary is a Base64 string representing raw wire octets. */
  rawBoundary?: boolean;
  rangeSpecificity?: 0 | 1;
  /** Valid declaration retained only so revision-3 invocation can rank before admitting carriage. */
  unsupported?: boolean;
  /** Threads the additive multipart semantics without changing direct legacy helper defaults. */
  revision3?: boolean;
  openapiVersion?: string;
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
export function planRequestBody(
  op: OpenAPIOperation,
  options: RequestPlanningOptions = {},
): BodyPlan {
  return planRequestBodies(op, options)[0] ?? { ...NO_BODY_PLAN };
}

/** Preserves all concrete supported request candidates without binding-spec preference. */
export function planRequestBodies(
  op: OpenAPIOperation,
  options: RequestPlanningOptions = {},
): BodyPlan[] {
  if (!hasRequestBody(op)) return [];
  const rb = op.requestBody!;
  const content = rb.content;
  if (!content || Object.keys(content).length === 0) return [];

  const revision3 = hasMediaFidelity(options.bindingSpec ?? "");
  const schemaOmittedOAS30Bytes = hasSchemaOmittedOAS30ByteCarriage(options.bindingSpec ?? "");
  const wholeJSON = hasWholeJSONCarriage(options.bindingSpec ?? "");
  const openapiVersion = options.openapiVersion ?? "3.0";
  interface Candidate {
    key: string;
    parsed: ParsedMediaType | ParsedMediaRange;
    family: string;
    range: boolean;
    rawOnlyRange?: boolean;
    unsupported?: boolean;
  }
  const candidates: Candidate[] = [];
  const declared: string[] = [];
  const identities = new Map<string, string>();
  for (const key of Object.keys(content)) {
    let parsed: ParsedMediaType | ParsedMediaRange;
    let range = false;
    try {
      parsed = parseMediaType(key, revision3);
    } catch {
      if (!revision3) {
        declared.push(key);
        continue;
      }
      try {
        parsed = parseMediaRange(key, revision3);
        range = true;
      } catch {
        declared.push(key);
        continue;
      }
    }
    declared.push(parsed.canonical);
    const previous = identities.get(parsed.identity);
    if (previous !== undefined) {
      throw new Error(
        `request content declarations ${JSON.stringify(previous)} and ${JSON.stringify(key)} denote the same parsed media type (OAPI-P-04 normalized collision)`,
      );
    }
    identities.set(parsed.identity, key);
    if (range) {
      const families = supportedRangeCarriageFamilies(
        parsed as ParsedMediaRange,
        content[key] ?? null,
        openapiVersion,
      );
      if (families.size === 0) {
        if (options.inventoryUnsupported) {
          candidates.push({ key, parsed, family: "", range: true, unsupported: true });
        }
        continue;
      }
      candidates.push({
        key,
        parsed,
        family: "",
        range: true,
        rawOnlyRange: families.size === 1 && families.has(FAMILY_RAW),
      });
      continue;
    }
    const media = content[key] ?? null;
    const family = concreteBodyFamily(
      parsed.base,
      mediaSchema(media),
      openapiVersion,
      revision3,
      revision3,
      schemaOmittedOAS30Bytes,
    );
    if (family) candidates.push({ key, parsed, family, range: false });
    else if (options.inventoryUnsupported) candidates.push({ key, parsed, family: "", range: false, unsupported: true });
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
      const plan = buildBodyPlan(rb.required === true, content, candidate, openapiVersion, revision3, wholeJSON);
      if (hasDynamicObjectCarriage(options.bindingSpec ?? "")) applyDynamicObjectShape(plan);
      plans.push(plan);
    } catch (error: unknown) {
      if (options.inventoryUnsupported) {
        plans.push(buildBodyPlan(
          rb.required === true,
          content,
          { ...candidate, family: "", unsupported: true },
          openapiVersion,
          revision3,
        ));
      }
      rejected.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (plans.length === 0) throw new DegenerateMediaError(rejected.join("; "));
  return plans;
}

function applyDynamicObjectShape(plan: BodyPlan): void {
  if (plan.synthetic || plan.unsupported) return;
  const raw = mediaSchema(plan.media);
  const schema = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  if (schema === null || !hasExplicitDynamicProperties(schema, new Set())) return;
  plan.wholeObject = true;
  plan.props = undefined;
}

function hasExplicitDynamicProperties(
  schema: Record<string, unknown>,
  seen: Set<Record<string, unknown>>,
): boolean {
  if (seen.has(schema)) return false;
  seen.add(schema);
  try {
    const patterns = asObject(schema.patternProperties);
    if (patterns && Object.keys(patterns).length > 0) return true;
    if (Object.hasOwn(schema, "additionalProperties") && schema.additionalProperties !== false) {
      return true;
    }
    return Array.isArray(schema.allOf) && schema.allOf.some((member) => {
      const nested = asObject(member);
      return nested !== null && hasExplicitDynamicProperties(nested, seen);
    });
  } finally {
    seen.delete(schema);
  }
}

/**
 * Proves that a range contains at least one concrete media type for which
 * revision 3 already defines carriage under this declaration's schema.
 * This is an existence check, not selection: invocation still requires an
 * actual configured concrete media type. A representative non-JSON member
 * may prove that the declaration can enter a raw lane, but it never becomes
 * a selected or emitted media type.
 */
export function rangeHasSupportedCarriage(
  range: ParsedMediaRange,
  media: OpenAPIMediaType | null,
  openapiVersion: string,
): boolean {
  return supportedRangeCarriageFamilies(range, media, openapiVersion).size > 0;
}

function supportedRangeCarriageFamilies(
  range: ParsedMediaRange,
  media: OpenAPIMediaType | null,
  openapiVersion: string,
): Set<string> {
  const schema = mediaSchema(media);
  const bases = representativeRangeMembers(range);
  const supported = new Set<string>();
  for (const base of bases) {
    const family = concreteBodyFamily(base, schema, openapiVersion, true, true);
    if (!family) continue;
    const suffix = range.canonical.slice(range.base.length);
    let parsed: ParsedMediaType;
    try { parsed = parseMediaType(`${base}${suffix}`, true); } catch { continue; }
    try {
      buildBodyPlan(
        false,
        { [range.canonical]: media ?? {} },
        { key: range.canonical, parsed, family, range: false },
        openapiVersion,
        true,
      );
      supported.add(family);
    } catch {
      // Try another concrete member/family before declaring the range inert.
    }
  }
  return supported;
}

function representativeRangeMembers(range: ParsedMediaRange): string[] {
  const type = range.base.slice(0, range.base.indexOf("/"));
  const bases: string[] = [];
  const add = (base: string): void => {
    if ((range.base === "*/*" || base.startsWith(`${type}/`)) && !bases.includes(base)) {
      bases.push(base);
    }
  };
  add("application/json");
  add("multipart/form-data");
  add("application/x-www-form-urlencoded");
  add("text/plain");
  add(`${type === "*" ? "application" : type}/x+json`);
  add(`${type === "*" ? "application" : type}/x-openbindings-representative`);
  return bases;
}

function buildBodyPlan(
  required: boolean,
  content: Record<string, OpenAPIMediaType>,
  candidate: { key: string; parsed: ParsedMediaType | ParsedMediaRange; family: string; range: boolean; rawOnlyRange?: boolean; unsupported?: boolean },
  openapiVersion: string,
  revision3: boolean,
  wholeJSON = false,
): BodyPlan {
  const plan: BodyPlan = {
    declared: true,
    required,
    mediaKey: candidate.key,
    mediaType: candidate.parsed.canonical,
    media: content[candidate.key] ?? null,
    family: candidate.family,
    synthetic: false,
    range: candidate.range,
    unsupported: candidate.unsupported === true,
    revision3,
    openapiVersion,
  };
  const schema = mediaSchema(plan.media);
  const objectSchema = schema && typeof schema === "object" ? schema : null;
  const declarationComplexJSON = wholeJSON
    && !candidate.range
    && candidate.family === FAMILY_JSON
    && objectSchema !== null
    && requiresWholeJSONCarriage(objectSchema, new Set());
  const shape = declarationComplexJSON
    ? { object: false, props: new Set<string>() }
    : typeof schema === "boolean"
    ? { object: false, props: new Set<string>() }
    : resolvedBodyShape(objectSchema, new Set());
  if (plan.unsupported) {
    plan.synthetic = schema === null || !shape.object;
    if (candidate.range) plan.rangeSpecificity = (candidate.parsed as ParsedMediaRange).specificity;
    if (!plan.synthetic && shape.props.size > 0) plan.props = shape.props;
    return plan;
  }
  if (candidate.range) {
    plan.synthetic = schema === null || !shape.object;
    plan.rangeSpecificity = (candidate.parsed as ParsedMediaRange).specificity;
    plan.rawBoundary = candidate.rawOnlyRange === true;
    if (!plan.synthetic && shape.props.size > 0) plan.props = shape.props;
    return plan;
  }
  if (revision3 && candidate.family === FAMILY_TEXT) {
    requireSupportedCharset(candidate.parsed, `request media ${plan.mediaType}`);
  }
  if (candidate.family === FAMILY_JSON) {
    if (declarationComplexJSON) {
      plan.wholeObject = true;
    } else {
      plan.synthetic = revision3 ? schema === null || !shape.object : schema !== null && !shape.object;
    }
  } else if (candidate.family === FAMILY_MULTIPART || candidate.family === FAMILY_URLENCODED) {
    // Revision 3 §9.1 defines neither declared property routes nor a whole
    // body expansion for schema-omitted form declarations. Guessing fields
    // from the caller value would add a binding-private rule, so @3 fails
    // closed until that rule is specified by a future binding revision.
    if (revision3 && schema === null) {
      throw new Error(`request media candidate ${plan.mediaType} omits the object schema required for faithful form routing`);
    }
    if (schema !== null && !shape.object) {
      throw new Error(`request media candidate ${plan.mediaType} has a non-object body schema and is inadmissible`);
    }
    if (revision3 && candidate.family === FAMILY_MULTIPART) {
      validateRevision3Multipart(plan.media, objectSchema, openapiVersion);
    } else if (revision3 && candidate.family === FAMILY_URLENCODED) {
      validateRevision3URLEncoded(plan.media, objectSchema, openapiVersion);
    }
  } else if (candidate.family === FAMILY_TEXT) {
    if (schema !== null && shape.object) {
      throw new Error("request media candidate text/plain has an object body schema and is inadmissible");
    }
    plan.synthetic = true;
  } else if (candidate.family === FAMILY_RAW) {
    plan.synthetic = true;
    plan.rawBoundary = revision3 && candidate.family === FAMILY_RAW;
  }
  if (!plan.synthetic && shape.props.size > 0) plan.props = shape.props;
  return plan;
}

/**
 * Reports top-level JSON Schema applicators whose complete validation and
 * possible object surface cannot be preserved by projecting a fixed set of
 * named body properties. Only `allOf` is traversed because nested property
 * schemas do not alter the top-level route shape.
 */
function requiresWholeJSONCarriage(
  schema: Record<string, unknown>,
  seen: Set<Record<string, unknown>>,
): boolean {
  if (seen.has(schema)) return false;
  seen.add(schema);
  try {
    const dependentSchemas = asObject(schema.dependentSchemas);
    if (
      Array.isArray(schema.oneOf)
      || Array.isArray(schema.anyOf)
      || schema.not !== undefined
      || schema.if !== undefined
      || schema.then !== undefined
      || schema.else !== undefined
      || (dependentSchemas !== null && Object.keys(dependentSchemas).length > 0)
      || (Object.hasOwn(schema, "unevaluatedProperties") && schema.unevaluatedProperties !== false)
    ) return true;
    return Array.isArray(schema.allOf) && schema.allOf.some((member) => {
      const nested = asObject(member);
      return nested !== null && requiresWholeJSONCarriage(nested, seen);
    });
  } finally {
    seen.delete(schema);
  }
}

function validateRevision3URLEncoded(
  media: OpenAPIMediaType | null,
  schema: Record<string, unknown> | null,
  openapiVersion: string,
): void {
  if (schema === null) return;
  const encoding = asObject(media?.encoding) ?? {};
  for (const [name, property] of Object.entries(resolvedMultipartPropertySchemas(schema, new Set()))) {
    if (property === false) continue;
    if (property === true || (!openapiVersion.startsWith("3.0") && !hasDeclaredSchemaType(property))) {
      throw new Error(
        `urlencoded property ${JSON.stringify(name)} has no revision-3 mapping from its default octets to a JSON caller value`,
      );
    }
    const enc = asObject(encoding[name]);
    if (Object.hasOwn(encoding, name) && enc === null) {
      throw new Error(`urlencoded property ${JSON.stringify(name)} declares an invalid Encoding Object`);
    }
    if (Object.hasOwn(enc ?? {}, "contentType") && typeof enc?.contentType !== "string") {
      throw new Error(`urlencoded property ${JSON.stringify(name)} declares a non-string encoding.contentType`);
    }
    if (legacyOpenAPIFormEncoding(openapiVersion) || hasExplicitMultipartExpansion(enc)) {
      validateFormStyle(name, property, enc, "urlencoded");
      continue;
    }
    if (openapiVersion.startsWith("3.0") && binarySignaled(property, true)) {
      throw new Error(
        `urlencoded binary property ${JSON.stringify(name)} has no Base64 boundary in this binding revision`,
      );
    }
    validateContentBasedMedia(name, property, enc, openapiVersion.startsWith("3.0"), "urlencoded");
  }
}

const SUPPORTED_CHARSETS = new Set(["utf-8", "us-ascii", "iso-8859-1"]);

function requireSupportedCharset(
  parsed: Pick<ParsedMediaType, "params">,
  subject: string,
): void {
  const charset = parsed.params["charset"];
  if (charset !== undefined && !SUPPORTED_CHARSETS.has(charset.toLowerCase())) {
    throw new Error(`${subject} declares unsupported charset ${JSON.stringify(charset)}`);
  }
}

function hasExplicitMultipartExpansion(enc: Record<string, unknown> | null): boolean {
  return enc !== null && (
    Object.hasOwn(enc, "style")
    || Object.hasOwn(enc, "explode")
    || Object.hasOwn(enc, "allowReserved")
  );
}

// OAS 3.0.0 through 3.0.3 apply form/explode defaults to urlencoded
// properties even when no Encoding Object is written. OAS 3.0.4 recommends
// the content-based interpretation, and the 3.1 line uses it when all three
// RFC6570 controls are absent. @3 incorporates each accepted edition's own
// immutable text, so older artifacts keep their older default.
function legacyOpenAPIFormEncoding(openapiVersion: string): boolean {
  return openapiVersion === "3.0.0"
    || openapiVersion === "3.0.1"
    || openapiVersion === "3.0.2"
    || openapiVersion === "3.0.3";
}

function validateFormStyle(
  name: string,
  schema: Record<string, unknown>,
  enc: Record<string, unknown> | null,
  subject: string,
): void {
  if (Object.hasOwn(enc ?? {}, "style") && (typeof enc?.style !== "string" || enc.style === "")) {
    throw new Error(`${subject} property ${JSON.stringify(name)} declares an invalid style`);
  }
  if (Object.hasOwn(enc ?? {}, "explode") && typeof enc?.explode !== "boolean") {
    throw new Error(`${subject} property ${JSON.stringify(name)} declares a non-boolean explode`);
  }
  if (Object.hasOwn(enc ?? {}, "allowReserved") && typeof enc?.allowReserved !== "boolean") {
    throw new Error(`${subject} property ${JSON.stringify(name)} declares a non-boolean allowReserved`);
  }
  const style = typeof enc?.style === "string" && enc.style !== "" ? enc.style : "form";
  const explode = typeof enc?.explode === "boolean" ? enc.explode : style === "form";
  const types = declaredSchemaTypes(schema);
  if (style === "form") return;
  if (style === "spaceDelimited" || style === "pipeDelimited") {
    if (explode || types.length === 0 || types.some((type) => type !== "array")) {
      throw new Error(
        `${subject} property ${JSON.stringify(name)} uses ${style}, which is defined only for arrays with explode=false`,
      );
    }
    return;
  }
  if (style === "deepObject") {
    if (!explode || types.length === 0 || types.some((type) => type !== "object")) {
      throw new Error(
        `${subject} property ${JSON.stringify(name)} uses deepObject, which is defined only for objects with explode=true`,
      );
    }
    return;
  }
  throw new Error(`${subject} property ${JSON.stringify(name)} declares unsupported style ${JSON.stringify(style)}`);
}

function declaredSchemaTypes(schema: Record<string, unknown>): string[] {
  const result = new Set<string>();
  if (typeof schema.type === "string") result.add(schema.type);
  else if (Array.isArray(schema.type)) {
    for (const type of schema.type) if (typeof type === "string") result.add(type);
  }
  if (Array.isArray(schema.allOf)) {
    for (const member of schema.allOf) {
      const nested = asObject(member);
      if (nested !== null) for (const type of declaredSchemaTypes(nested)) result.add(type);
    }
  }
  return [...result];
}

function validateRevision3Multipart(
  media: OpenAPIMediaType | null,
  schema: Record<string, unknown> | null,
  openapiVersion: string,
): void {
  const encoding = asObject(media?.encoding) ?? {};
  for (const [name, rawEncoding] of Object.entries(encoding)) {
    const enc = asObject(rawEncoding);
    if (enc === null) {
      throw new Error(`multipart property ${JSON.stringify(name)} declares an invalid Encoding Object`);
    }
    const headers = asObject(enc.headers);
    if (Object.hasOwn(enc, "headers") && headers === null) {
      throw new Error(`multipart property ${JSON.stringify(name)} declares invalid encoding.headers`);
    }
    if (headers !== null && Object.keys(headers).length > 0) {
      throw new Error(
        `multipart property ${JSON.stringify(name)} declares encoding.headers, for which this binding revision defines no caller source mapping`,
      );
    }
    if (Object.hasOwn(enc, "contentType") && typeof enc.contentType !== "string") {
      throw new Error(`multipart property ${JSON.stringify(name)} declares a non-string encoding.contentType`);
    }
    if (!hasExplicitMultipartExpansion(enc) && typeof enc.contentType === "string") {
      parseSingleMultipartContentType(enc.contentType, name);
    }
  }
  if (schema === null) return;
  for (const [name, property] of Object.entries(resolvedMultipartPropertySchemas(schema, new Set()))) {
    if (property === false) continue;
    if (property === true || (!openapiVersion.startsWith("3.0") && !hasDeclaredSchemaType(property))) {
      throw new Error(
        `multipart property ${JSON.stringify(name)} has a typeless OAS 3.1 schema whose octet-stream boundary is not defined by this binding revision`,
      );
    }
    validateContentTransferEncoding(name, property);
    const enc = asObject(encoding[name]);
    if (hasExplicitMultipartExpansion(enc)) {
      validateFormStyle(name, property, enc, "multipart");
    }
    let contentSchema = property;
    if (schemaTypeIs(property, "array") && !hasExplicitMultipartExpansion(enc)) {
      const items = resolvedMultipartItemsSchema(property);
      if (items === false) continue;
      if (items === null || items === true || !hasDeclaredSchemaType(items)) {
        throw new Error(
          `multipart array property ${JSON.stringify(name)} has typeless items whose octet-stream boundary is not defined by this binding revision`,
        );
      }
      if (schemaTypeIs(items, "array")) {
        throw new Error(
          `multipart array property ${JSON.stringify(name)} has nested array items with no revision-3 repeated-part mapping`,
        );
      }
      validateContentTransferEncoding(name, items);
      contentSchema = items;
    }
    if (!hasExplicitMultipartExpansion(enc)) {
      validateContentBasedMedia(name, contentSchema, enc, openapiVersion.startsWith("3.0"), "multipart");
    }
  }
}

function validateContentBasedMedia(
  name: string,
  schema: Record<string, unknown>,
  enc: Record<string, unknown> | null,
  is30: boolean,
  subject: string,
): void {
  const selected = typeof enc?.contentType === "string"
    ? parseSingleMultipartContentType(enc.contentType, name)
    : parseMediaType(defaultMultipartContentType(schema, is30), true);
  requireSupportedCharset(selected, `${subject} property ${JSON.stringify(name)}`);
  if (isJSONMediaType(selected.base)) return;
  if (selected.base === "text/plain") {
    const types = declaredSchemaTypes(schema);
    if (types.length === 0 || types.some((type) => !["string", "number", "integer", "boolean", "null"].includes(type))) {
      throw new Error(`${subject} property ${JSON.stringify(name)} cannot serialize its schema as text/plain`);
    }
    return;
  }
  const encodedString = !is30
    && schemaTypeIs(schema, "string")
    && resolvedSchemaStringKeyword(schema, "contentEncoding") !== "";
  // OAS 3.0 format: binary declares raw part bytes; encoding.contentType
  // describes those bytes and is not restricted to application/octet-stream.
  // A ZIP/image/vendor part therefore uses the same canonical Base64 caller
  // boundary as the default octet-stream case.
  if (is30 && binarySignaled(schema, true)) return;
  if (selected.base === "application/octet-stream" && encodedString) return;
  throw new Error(`${subject} property ${JSON.stringify(name)} has no serializer for ${selected.canonical}`);
}

function validateContentTransferEncoding(name: string, schema: Record<string, unknown>): void {
  const encoding = resolvedSchemaStringKeyword(schema, "contentEncoding");
  if (encoding !== "" && !HTTP_TOKEN.test(encoding)) {
    throw new Error(
      `multipart property ${JSON.stringify(name)} has contentEncoding ${JSON.stringify(encoding)} that cannot be emitted as Content-Transfer-Encoding`,
    );
  }
}

function resolvedMultipartItemsSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> | boolean | null {
  if (typeof schema.items === "boolean") return schema.items;
  const direct = asObject(schema.items);
  if (direct !== null) return direct;
  if (Array.isArray(schema.allOf)) {
    const members = schema.allOf
      .map((member) => asObject(member))
      .filter((member): member is Record<string, unknown> => member !== null)
      .map((member) => resolvedMultipartItemsSchema(member))
      .filter((member): member is Record<string, unknown> | boolean => member !== null);
    if (members.includes(false)) return false;
    const objects = members.filter((member): member is Record<string, unknown> => typeof member === "object");
    if (objects.length > 0) return objects.length === 1 ? objects[0]! : { allOf: objects };
    if (members.includes(true)) return true;
  }
  return null;
}

function resolvedMultipartPropertySchemas(
  schema: Record<string, unknown>,
  seen: Set<Record<string, unknown>>,
): Record<string, Record<string, unknown> | boolean> {
  if (seen.has(schema)) return {};
  seen.add(schema);
  try {
    const result: Record<string, Record<string, unknown> | boolean> = {};
    const own = asObject(schema.properties);
    for (const [name, property] of Object.entries(own ?? {})) {
      if (typeof property === "boolean") result[name] = property;
      else {
        const object = asObject(property);
        if (object !== null) result[name] = object;
      }
    }
    if (Array.isArray(schema.allOf)) {
      for (const member of schema.allOf) {
        const nested = asObject(member);
        if (nested === null) continue;
        for (const [name, property] of Object.entries(resolvedMultipartPropertySchemas(nested, seen))) {
          const previous = result[name];
          if (previous === undefined) result[name] = property;
          else if (previous === false || property === false) result[name] = false;
          else if (previous === true) result[name] = property;
          else if (property !== true) result[name] = { allOf: [previous, property] };
        }
      }
    }
    return result;
  } finally {
    seen.delete(schema);
  }
}

function hasDeclaredSchemaType(schema: Record<string, unknown>): boolean {
  if (typeof schema.type === "string" && schema.type !== "") return true;
  if (Array.isArray(schema.type) && schema.type.some((type) => typeof type === "string" && type !== "")) return true;
  return Array.isArray(schema.allOf) && schema.allOf.some((member) => {
    const nested = asObject(member);
    return nested !== null && hasDeclaredSchemaType(nested);
  });
}

function parseSingleMultipartContentType(raw: string, name: string): ParsedMediaType {
  const members = splitCommaList(raw);
  if (members.length !== 1) {
    throw new Error(
      `multipart property ${JSON.stringify(name)} declares multiple encoding.contentType members, for which this binding revision defines no part-selection rule`,
    );
  }
  try {
    return parseMediaType(members[0]!, true);
  } catch (error: unknown) {
    throw new Error(
      `multipart property ${JSON.stringify(name)} encoding.contentType must be one concrete media type: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function splitCommaList(raw: string): string[] {
  const members: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (escaped) escaped = false;
    else if (char === "\\" && quoted) escaped = true;
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      const member = raw.slice(start, index).trim();
      if (member !== "") members.push(member);
      start = index + 1;
    }
  }
  const member = raw.slice(start).trim();
  if (member !== "") members.push(member);
  return members;
}

function concreteBodyFamily(
  base: string,
  schema: MediaSchema,
  openapiVersion: string,
  revision3: boolean,
  allowRaw: boolean,
  allowSchemaOmittedOAS30Bytes = false,
): string {
  if (isJSONMediaType(base)) return FAMILY_JSON;
  if (base === "multipart/form-data") return FAMILY_MULTIPART;
  if (base === "application/x-www-form-urlencoded") return FAMILY_URLENCODED;
  if (base === "text/plain") return FAMILY_TEXT;
  if (!revision3) return "";
  if (allowRaw && rawBoundarySchema(schema, openapiVersion, allowSchemaOmittedOAS30Bytes)) return FAMILY_RAW;
  // In OAS 3.1 contentEncoding describes the string's own representation.
  // The caller supplies that encoded string verbatim; it is not decoded at
  // the OpenBindings boundary merely because the concrete media is binary.
  if (
    !openapiVersion.startsWith("3.0")
    && schema !== null
    && typeof schema === "object"
    && schemaTypeIs(schema, "string")
    && resolvedSchemaStringKeyword(schema, "contentEncoding") !== ""
  ) {
    return FAMILY_TEXT;
  }
  return "";
}

function rawBoundarySchema(
  schema: MediaSchema,
  openapiVersion: string,
  allowSchemaOmittedOAS30Bytes = false,
): boolean {
  if (openapiVersion.startsWith("3.0")) {
    return (allowSchemaOmittedOAS30Bytes && schema === null)
      || (schema !== null && typeof schema === "object" && schemaTypeIs(schema, "string") && schemaFormatIs(schema, "binary"));
  }
  return schema === null;
}

function schemaFormatIs(schema: Record<string, unknown>, want: string): boolean {
  if (schema.format === want) return true;
  return Array.isArray(schema.allOf) && schema.allOf.some((member) => {
    const nested = member && typeof member === "object" && !Array.isArray(member)
      ? member as Record<string, unknown>
      : null;
    return nested !== null && schemaFormatIs(nested, want);
  });
}

/**
 * Resolves revision-3 range declarations against one configured concrete
 * request media. Exact declarations win over subtype-wildcard declarations,
 * which win over the all-media wildcard.
 * The chosen declaration is then admitted only through an already-defined
 * concrete carriage family; schema shape never invents a JSON lane.
 */
export function configureRequestMedia(
  plans: BodyPlan[],
  configured: string,
  options: RequestPlanningOptions,
): BodyPlan[] {
  let concrete: ParsedMediaType;
  try {
    concrete = parseMediaType(configured, true);
  } catch {
    return [];
  }
  const matches: Array<{ plan: BodyPlan; specificity: number; parameters: number }> = [];
  for (const plan of plans) {
    if (!plan.range) {
      try {
        const declared = parseMediaType(plan.mediaKey, true);
        if (declared.base === concrete.base && mediaParametersMatch(declared, concrete)) {
          matches.push({ plan, specificity: 2, parameters: Object.keys(declared.params).length });
        }
      } catch { /* planning already rejected invalid declarations */ }
      continue;
    }
    let range: ParsedMediaRange;
    try { range = parseMediaRange(plan.mediaKey, true); } catch { continue; }
    if (!mediaRangeMatches(range, concrete)) continue;
    matches.push({ plan, specificity: range.specificity, parameters: Object.keys(range.params).length });
  }
  if (matches.length === 0) return [];
  const specificity = Math.max(...matches.map((match) => match.specificity));
  const atSpecificity = matches.filter((match) => match.specificity === specificity);
  const parameterCount = Math.max(...atSpecificity.map((match) => match.parameters));
  const selected = atSpecificity.filter((match) => match.parameters === parameterCount);
  if (selected.length !== 1) return [];
  const plan = selected[0]!.plan;
  if (plan.unsupported) return [];
  if (!plan.range) return [{ ...plan, mediaType: concrete.canonical }];

  const schema = mediaSchema(plan.media);
  const family = concreteBodyFamily(
    concrete.base,
    schema,
    options.openapiVersion ?? "3.0",
    true,
    true,
  );
  if (!family) return [];
  try {
    return [buildBodyPlan(
      plan.required,
      { [plan.mediaKey]: plan.media ?? {} },
      { key: plan.mediaKey, parsed: concrete, family, range: false },
      options.openapiVersion ?? "3.0",
      true,
    )].map((resolved) => ({
      ...resolved,
      mediaKey: plan.mediaKey,
      mediaType: concrete.canonical,
      range: true,
      rangeSpecificity: plan.rangeSpecificity,
      // Keep invocation routing identical to the static range contract. In
      // particular, a schema-omitted range always uses the synthetic whole
      // body even when the configured concrete member is JSON.
      synthetic: plan.synthetic,
      wholeObject: plan.wholeObject,
      props: plan.props,
    }));
  } catch {
    return [];
  }
}

function mediaRangeMatches(range: ParsedMediaRange, concrete: ParsedMediaType): boolean {
  if (range.base !== "*/*" && range.base.slice(0, range.base.indexOf("/")) !== concrete.base.slice(0, concrete.base.indexOf("/"))) {
    return false;
  }
  return mediaParametersMatch(range, concrete);
}

function mediaParametersMatch(
  declared: Pick<ParsedMediaType, "params">,
  concrete: ParsedMediaType,
): boolean {
  return Object.entries(declared.params).every(([name, value]) => concrete.params[name] === value);
}

function mediaSchema(media: OpenAPIMediaType | null): MediaSchema {
  if (!media || !Object.hasOwn(media, "schema")) return null;
  const schema = media?.schema;
  if (typeof schema === "boolean") return schema;
  return schema && typeof schema === "object" ? schema : null;
}

/**
 * Whether revision 4's protocol-independent output boundary carries the
 * exact response octets as canonical Base64. JSON, text, and SSE retain
 * their application-value lanes; only artifact-authorized binary forms use
 * the byte boundary.
 */
export function responseUsesRawBoundary(
  media: OpenAPIMediaType,
  actualContentType: string,
  openapiVersion: string,
  bindingSpec = "",
  exactDeclaration = true,
): boolean {
  const actual = parseMediaType(actualContentType, true).base;
  if (isJSONMediaType(actual) || actual.startsWith("text/")) return false;
  const schema = mediaSchema(media);
  if (openapiVersion.startsWith("3.0")) {
    return (hasSchemaOmittedOAS30ByteCarriage(bindingSpec) && exactDeclaration && !Object.hasOwn(media, "schema"))
      || (schema !== null
      && typeof schema === "object"
      && binarySignaled(schema, true));
  }
  return !Object.hasOwn(media, "schema");
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
    return ((plan.synthetic || plan.wholeObject) && name === "body")
      || (!plan.synthetic && !plan.wholeObject && plan.props?.has(name) === true);
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
  /** Selected multipart declaration awaiting a runtime-generated or author-declared boundary. */
  multipartMediaType?: string;
  /** Static schema-owned Content-Transfer-Encoding headers by part name. */
  multipartTransferEncodings?: Record<string, string>;
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
      if (plan.synthetic || plan.wholeObject) {
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
      const fields = objectBodyFields(plan, routed);
      if (Object.keys(fields).length === 0 && !plan.required) {
        return { body: undefined, contentType: "" };
      }
      // The runtime stamps the multipart boundary onto Content-Type itself.
      return {
        body: buildMultipartBody(
          doc,
          plan.media,
          fields,
          plan.revision3 === true,
          plan.wholeObject === true,
        ),
        contentType: "",
        ...(plan.revision3 === true ? {
          multipartMediaType: plan.mediaType,
          multipartTransferEncodings: multipartTransferEncodings(doc, plan.media),
        } : {}),
      };
    }
    case FAMILY_URLENCODED: {
      const fields = objectBodyFields(plan, routed);
      if (Object.keys(fields).length === 0 && !plan.required) {
        return { body: undefined, contentType: "" };
      }
      return {
        body: buildURLEncodedBody(
          plan.media,
          fields,
          plan.revision3 === true,
          plan.openapiVersion ?? "3.0",
          plan.wholeObject === true,
        ),
        contentType: plan.mediaType,
      };
    }
    case FAMILY_TEXT: {
      if (!routed.bodySet) return { body: undefined, contentType: "" };
      if (typeof routed.bodyValue !== "string") {
        // The selection condition failed: text/plain is selected only when
        // the body value is a string (OAPI-P-04).
        throw new Error(
          `request media ${plan.mediaType} was selected but the body value is ${typeof routed.bodyValue}, not a string`,
        );
      }
      return {
        body: plan.revision3 === true && Object.hasOwn(parseMediaType(plan.mediaType, true).params, "charset")
          ? encodeTextForMedia(routed.bodyValue, plan.mediaType, "request body")
          : routed.bodyValue,
        contentType: plan.mediaType,
      };
    }
    case FAMILY_RAW: {
      if (!routed.bodySet) return { body: undefined, contentType: "" };
      return {
        body: decodeBoundaryBase64(routed.bodyValue, plan.mediaType),
        contentType: plan.mediaType,
      };
    }
  }
  throw new Error(`unknown body family "${plan.family}"`);
}

/**
 * Materializes a revision-3 multipart FormData body before dispatch so the
 * selected declaration's non-boundary parameters survive and an explicit
 * boundary, when present, is the boundary used by both header and bytes.
 */
export async function finalizeRequestBody(wire: WireBody): Promise<WireBody> {
  if (!wire.multipartMediaType || !(wire.body instanceof FormData)) return wire;
  const selected = parseMediaType(wire.multipartMediaType, true);
  const generated = new Response(wire.body);
  const runtimeType = generated.headers.get("content-type") ?? "";
  const runtime = parseMediaType(runtimeType, true);
  const runtimeBoundary = runtime.params["boundary"];
  if (!runtimeBoundary) throw new Error("multipart runtime did not generate a boundary");

  const declaredBoundary = selected.params["boundary"];
  const boundary = declaredBoundary ?? runtimeBoundary;
  if (declaredBoundary !== undefined) validateMultipartBoundary(declaredBoundary);
  let bytes = new Uint8Array(await generated.arrayBuffer());
  if (boundary !== runtimeBoundary) {
    bytes = replaceMultipartBoundary(bytes, runtimeBoundary, boundary);
  }
  if (wire.multipartTransferEncodings && Object.keys(wire.multipartTransferEncodings).length > 0) {
    bytes = insertMultipartTransferEncodingHeaders(bytes, boundary, wire.multipartTransferEncodings);
  }

  const params: Record<string, string> = { ...selected.renderedParams, boundary };
  const contentType = selected.base + Object.keys(params)
    .sort()
    .map((name) => `; ${name}=${formatParameter(params[name]!)}`)
    .join("");
  return { body: bytes, contentType };
}

function insertMultipartTransferEncodingHeaders(
  bytes: Uint8Array,
  boundary: string,
  encodings: Record<string, string>,
): Uint8Array<ArrayBuffer> {
  const delimiter = new TextEncoder().encode(`--${boundary}\r\n`);
  const headerEnd = new Uint8Array([13, 10, 13, 10]);
  const insertions: Array<{ at: number; bytes: Uint8Array }> = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    const delimiterAt = byteIndexOf(bytes, delimiter, cursor);
    if (delimiterAt < 0) break;
    const headersAt = delimiterAt + delimiter.length;
    const end = byteIndexOf(bytes, headerEnd, headersAt);
    if (end < 0) break;
    const headers = new TextDecoder().decode(bytes.slice(headersAt, end));
    const match = /(?:^|\r\n)Content-Disposition:[^\r\n]*; name="([^"]*)"/i.exec(headers);
    const encoding = match ? encodings[match[1]!] : undefined;
    if (encoding !== undefined) {
      insertions.push({
        at: end + 2,
        bytes: new TextEncoder().encode(`Content-Transfer-Encoding: ${encoding}\r\n`),
      });
    }
    cursor = end + headerEnd.length;
  }
  if (insertions.length === 0) return Uint8Array.from(bytes);
  const added = insertions.reduce((total, insertion) => total + insertion.bytes.length, 0);
  const result = new Uint8Array(bytes.length + added);
  let source = 0;
  let target = 0;
  for (const insertion of insertions) {
    result.set(bytes.slice(source, insertion.at), target);
    target += insertion.at - source;
    result.set(insertion.bytes, target);
    target += insertion.bytes.length;
    source = insertion.at;
  }
  result.set(bytes.slice(source), target);
  return result;
}

function byteIndexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let index = from; index <= haystack.length - needle.length; index++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function multipartTransferEncodings(
  doc: OpenAPIDocument,
  media: OpenAPIMediaType | null,
): Record<string, string> {
  if (isOpenAPI30(doc)) return {};
  const rawSchema = mediaSchema(media);
  const schema = rawSchema && typeof rawSchema === "object" ? rawSchema : null;
  if (schema === null) return {};
  const result: Record<string, string> = {};
  for (const [name, property] of Object.entries(resolvedMultipartProperties(schema, new Set()))) {
    const partSchema = schemaTypeIs(property, "array")
      ? resolvedMultipartItems(property)
      : property;
    const encoding = resolvedSchemaStringKeyword(partSchema, "contentEncoding");
    if (encoding !== "") result[name] = encoding;
  }
  return result;
}

function validateMultipartBoundary(boundary: string): void {
  if (
    boundary.length < 1
    || boundary.length > 70
    || boundary.endsWith(" ")
    || !/^[0-9A-Za-z'()+_,./:=? -]+$/.test(boundary)
  ) {
    throw new Error(`multipart boundary ${JSON.stringify(boundary)} is not a valid RFC 2046 boundary`);
  }
}

function objectBodyFields(plan: BodyPlan, routed: RoutedBody): Record<string, unknown> {
  if (!plan.wholeObject) return routed.bodyFields;
  if (!routed.bodySet) return {};
  const value = asObject(routed.bodyValue);
  if (value === null) {
    throw new Error(`request media ${plan.mediaType} requires the whole body value to be an object`);
  }
  return value;
}

function replaceMultipartBoundary(
  bytes: Uint8Array,
  from: string,
  to: string,
): Uint8Array<ArrayBuffer> {
  const source = new TextEncoder().encode(`--${from}`);
  const replacement = new TextEncoder().encode(`--${to}`);
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index <= bytes.length - source.length; index++) {
    let equal = true;
    for (let offset = 0; offset < source.length; offset++) {
      if (bytes[index + offset] !== source[offset]) { equal = false; break; }
    }
    if (!equal) continue;
    const lineStart = index === 0 || (index >= 2 && bytes[index - 2] === 13 && bytes[index - 1] === 10);
    const after = index + source.length;
    const lineEnd = (
      bytes[after] === 13 && bytes[after + 1] === 10
    ) || (
      bytes[after] === 45 && bytes[after + 1] === 45
    );
    if (!lineStart || !lineEnd) continue;
    chunks.push(bytes.slice(start, index), replacement);
    start = after;
    index = after - 1;
  }
  if (chunks.length === 0) throw new Error("multipart runtime boundary was absent from the serialized body");
  chunks.push(bytes.slice(start));
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function encodeTextForMedia(value: unknown, mediaType: string, subject: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string") {
    throw new Error(`${subject} requires a string value`);
  }
  const parsed = parseMediaType(mediaType, true);
  requireSupportedCharset(parsed, subject);
  switch ((parsed.params["charset"] ?? "utf-8").toLowerCase()) {
    case "utf-8":
      return new TextEncoder().encode(value);
    case "us-ascii": {
      const result = new Uint8Array(value.length);
      for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code > 0x7f) throw new Error(`${subject} cannot represent U+${code.toString(16).toUpperCase().padStart(4, "0")} as US-ASCII`);
        result[index] = code;
      }
      return result;
    }
    case "iso-8859-1": {
      const result = new Uint8Array(value.length);
      for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code > 0xff) throw new Error(`${subject} cannot represent U+${code.toString(16).toUpperCase().padStart(4, "0")} as ISO-8859-1`);
        result[index] = code;
      }
      return result;
    }
  }
  throw new Error(`${subject} declares an unsupported charset`);
}

function decodeBoundaryBase64(value: unknown, mediaType: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string") {
    throw new Error(`request media ${mediaType} requires a Base64 string at the OpenBindings body boundary`);
  }
  if (
    value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error(`request media ${mediaType} received an invalid Base64 body`);
  }
  try {
    const binary = atob(value);
    if (btoa(binary) !== value) {
      throw new Error("non-canonical Base64");
    }
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new Error(`request media ${mediaType} received an invalid Base64 body`);
  }
}

// ---------------------------------------------------------------------------
// Multipart (OAPI-P-04's part-encoding rules)
// ---------------------------------------------------------------------------

function isOpenAPI30(doc: OpenAPIDocument): boolean {
  return typeof doc.openapi === "string" && doc.openapi.startsWith("3.0");
}

/**
 * Encodes body fields as multipart/form-data. OAS 3.0 `format: binary`
 * parts use the Base64 boundary. Revision 3 keeps OAS 3.1 contentEncoding
 * strings (and identity-encoded contentMediaType strings) unchanged; the
 * compatibility revisions retain their historical decode behavior. Other
 * parts serialize per the artifact's encoding object or OAS defaults.
 * Nothing is decided by payload sniffing, and fields are sorted.
 */
export function buildMultipartBody(
  doc: OpenAPIDocument,
  media: OpenAPIMediaType | null,
  fields: Record<string, unknown>,
  revision3 = false,
  dynamicProperties = false,
): FormData {
  const fd = new FormData();
  const is30 = isOpenAPI30(doc);
  const rawSchema = mediaSchema(media);
  const schema = rawSchema && typeof rawSchema === "object" ? rawSchema : null;
  const encoding = (media?.encoding ?? {}) as Record<string, Record<string, unknown>>;

  for (const name of Object.keys(fields).sort()) {
    const value = fields[name];
    const propSchema = dynamicProperties
      ? resolvedMultipartProperty(schema, name, new Set())
      : asObject(resolvedMultipartProperties(schema, new Set())[name]);
    const enc = asObject(encoding[name]);

    // A declared array expands into repeated parts of the same name, each
    // element encoded per the items schema (the multipart way to carry
    // arrays — including arrays of files).
    if (
      propSchema
      && schemaTypeIs(propSchema, "array")
      && !(revision3 && hasExplicitMultipartExpansion(enc))
    ) {
      const arr = asArray(value);
      if (arr) {
        const items = resolvedMultipartItems(propSchema);
        for (const elem of arr) {
          writeMultipartPart(fd, name, elem, items, enc, is30, revision3);
        }
        continue;
      }
    }
    writeMultipartPart(fd, name, value, propSchema, enc, is30, revision3);
  }
  return fd;
}

function resolvedMultipartProperty(
  schema: Record<string, unknown> | null,
  name: string,
  seen: Set<Record<string, unknown>>,
): Record<string, unknown> | null {
  if (schema === null || seen.has(schema)) return null;
  seen.add(schema);
  try {
    const candidates: Record<string, unknown>[] = [];
    const properties = asObject(schema.properties);
    const exact = properties ? asObject(properties[name]) : null;
    if (exact !== null) candidates.push(exact);

    let patternMatched = false;
    const patterns = asObject(schema.patternProperties);
    for (const [pattern, raw] of Object.entries(patterns ?? {})) {
      let matches = false;
      try { matches = new RegExp(pattern, "u").test(name); } catch { /* validation owns invalid patterns */ }
      if (!matches) continue;
      patternMatched = true;
      const candidate = asObject(raw);
      if (candidate !== null) candidates.push(candidate);
    }

    if (exact === null && !patternMatched) {
      const additional = schema.additionalProperties;
      const candidate = asObject(additional);
      if (candidate !== null) candidates.push(candidate);
      else if (additional === true || !Object.hasOwn(schema, "additionalProperties")) candidates.push({});
    }

    if (Array.isArray(schema.allOf)) {
      for (const member of schema.allOf) {
        const nested = asObject(member);
        if (nested === null) continue;
        const candidate = resolvedMultipartProperty(nested, name, seen);
        if (candidate !== null) candidates.push(candidate);
      }
    }
    if (candidates.length === 0) return null;
    return candidates.length === 1 ? candidates[0]! : { allOf: candidates };
  } finally {
    seen.delete(schema);
  }
}

function schemaTypeIs(schema: Record<string, unknown>, want: string): boolean {
  const ty = schema.type;
  if (typeof ty === "string") return ty === want;
  if (Array.isArray(ty)) return ty.includes(want);
  return Array.isArray(schema.allOf) && schema.allOf.some(member => {
    const nested = asObject(member);
    return nested !== null && schemaTypeIs(nested, want);
  });
}

function resolvedMultipartProperties(
  schema: Record<string, unknown> | null,
  seen: Set<Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  if (schema === null || seen.has(schema)) return {};
  seen.add(schema);
  try {
    const result: Record<string, Record<string, unknown>> = {};
    const own = asObject(schema.properties);
    for (const [name, property] of Object.entries(own ?? {})) {
      const value = asObject(property);
      if (value !== null) result[name] = value;
    }
    if (Array.isArray(schema.allOf)) {
      for (const member of schema.allOf) {
        const nested = asObject(member);
        if (nested === null) continue;
        for (const [name, property] of Object.entries(resolvedMultipartProperties(nested, seen))) {
          result[name] = result[name] === undefined
            ? property
            : { allOf: [result[name], property] };
        }
      }
    }
    return result;
  } finally {
    seen.delete(schema);
  }
}

function writeMultipartPart(
  fd: FormData,
  name: string,
  value: unknown,
  schema: Record<string, unknown> | null,
  enc: Record<string, unknown> | null,
  is30: boolean,
  revision3: boolean,
): void {
  if (revision3) {
    writeRevision3MultipartPart(fd, name, value, schema, enc, is30);
    return;
  }
  const encContentType = typeof enc?.contentType === "string" ? enc.contentType : "";

  if (revision3 && !is30 && schema !== null && schemaTypeIs(schema, "string")) {
    const contentEncoding = resolvedSchemaStringKeyword(schema, "contentEncoding");
    const contentMediaType = resolvedSchemaStringKeyword(schema, "contentMediaType");
    if (contentEncoding !== "" || contentMediaType !== "") {
      if (typeof value !== "string") {
        throw new Error(`multipart part ${JSON.stringify(name)} requires an artifact-encoded string value`);
      }
      const contentType = encContentType || contentMediaType;
      if (contentType !== "") {
        fd.append(name, new Blob([value], { type: contentType }), name);
      } else {
        fd.append(name, value);
      }
      return;
    }
  }

  if (binarySignaled(schema, is30)) {
    // An in-process Blob passes through raw (it cannot have arrived as
    // JSON) — the convenience counterpart of Go's []byte passthrough.
    const ct =
      encContentType ||
      declaredContentMediaType(schema) ||
      "application/octet-stream";
    if (revision3 && is30) {
      if (typeof value !== "string") {
        throw new Error(`binary part ${JSON.stringify(name)}: revision 3 requires a canonical Base64 string`);
      }
      const data = binaryPartBytes(name, value, "", true);
      fd.append(name, new Blob([data as BlobPart], { type: ct }), name);
      return;
    }
    if (value instanceof Blob) {
      fd.append(name, value.type ? value : new Blob([value], { type: ct }), name);
      return;
    }
    const data = binaryPartBytes(
      name,
      value,
      declaredContentEncoding(schema, is30),
      revision3 && is30,
    );
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

function writeRevision3MultipartPart(
  fd: FormData,
  name: string,
  value: unknown,
  schema: Record<string, unknown> | null,
  enc: Record<string, unknown> | null,
  is30: boolean,
): void {
  if (hasExplicitMultipartExpansion(enc)) {
    const style = typeof enc?.style === "string" && enc.style !== "" ? enc.style : "form";
    const explode = typeof enc?.explode === "boolean" ? enc.explode : style === "form";
    let parts: Array<[string, string]>;
    try {
      parts = serializeMultipartValue(name, value, style, explode);
    } catch (error: unknown) {
      throw new Error(
        `multipart property ${JSON.stringify(name)}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    for (const [partName, partValue] of parts) fd.append(partName, partValue);
    return;
  }

  if (schema === null || (!is30 && !hasDeclaredSchemaType(schema))) {
    throw new Error(
      `multipart property ${JSON.stringify(name)} has no revision-3 mapping from its default octet-stream part to a JSON caller value`,
    );
  }

  const declaredEncodingType = typeof enc?.contentType === "string"
    ? parseSingleMultipartContentType(enc.contentType, name)
    : null;
  const selected = declaredEncodingType
    ?? parseMediaType(defaultMultipartContentType(schema, is30), true);
  requireSupportedCharset(selected, `multipart property ${JSON.stringify(name)}`);
  const contentType = selected.canonical;

  const contentEncoding = !is30 && schemaTypeIs(schema, "string")
    ? resolvedSchemaStringKeyword(schema, "contentEncoding")
    : "";
  if (contentEncoding !== "") {
    const data = encodeTextForMedia(value, contentType, `multipart property ${JSON.stringify(name)}`);
    fd.append(name, new Blob([data], { type: contentType }), name);
    return;
  }

  if (is30 && binarySignaled(schema, true)) {
    if (typeof value !== "string") {
      throw new Error(`binary part ${JSON.stringify(name)}: revision 3 requires a canonical Base64 string`);
    }
    const data = binaryPartBytes(name, value, "", true);
    fd.append(name, new Blob([data as BlobPart], { type: contentType }), name);
    return;
  }

  if (isJSONMediaType(selected.base)) {
    fd.append(name, new Blob([JSON.stringify(value ?? null)], { type: contentType }), name);
    return;
  }

  if (selected.base === "application/octet-stream" && contentEncoding !== "") {
    if (typeof value !== "string") {
      throw new Error(is30
        ? `binary part ${JSON.stringify(name)}: revision 3 requires a canonical Base64 string`
        : `octet-stream part ${JSON.stringify(name)} requires an artifact-encoded string`);
    }
    const data = is30
      ? binaryPartBytes(name, value, "", true)
      : encodeTextForMedia(value, contentType, `multipart property ${JSON.stringify(name)}`);
    fd.append(name, new Blob([data as BlobPart], { type: contentType }), name);
    return;
  }

  if (selected.base !== "text/plain") {
    throw new Error(
      `multipart property ${JSON.stringify(name)} has no serializer for ${contentType}`,
    );
  }

  const text = primitiveString(value);
  if (
    declaredEncodingType === null
    && selected.base === "text/plain"
    && Object.keys(selected.params).length === 0
  ) {
    fd.append(name, text);
    return;
  }
  const data = encodeTextForMedia(text, contentType, `multipart property ${JSON.stringify(name)}`);
  fd.append(name, new Blob([data], { type: contentType }), name);
}

function defaultMultipartContentType(schema: Record<string, unknown>, is30: boolean): string {
  if (is30 && binarySignaled(schema, true)) return "application/octet-stream";
  if (!is30 && resolvedSchemaStringKeyword(schema, "contentEncoding") !== "") {
    return "application/octet-stream";
  }
  if (schemaTypeIs(schema, "object") || schemaTypeIs(schema, "array")) return "application/json";
  if (
    schemaTypeIs(schema, "string")
    || schemaTypeIs(schema, "number")
    || schemaTypeIs(schema, "integer")
    || schemaTypeIs(schema, "boolean")
  ) {
    return "text/plain";
  }
  throw new Error("multipart property has no declaration-defined default Content-Type");
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
 * The compatibility-edition binary signal. Revision 3 intercepts OAS 3.1
 * encoded strings before this legacy path.
 */
export function binarySignaled(schema: Record<string, unknown> | null, is30: boolean): boolean {
  if (!schema) return false;
  const direct = is30
    ? schema.format === "binary"
    : schemaTypeIs(schema, "string") && (
    declaredContentMediaType(schema) !== "" || declaredContentEncoding(schema, false) !== ""
  );
  if (direct) return true;
  return Array.isArray(schema.allOf) && schema.allOf.some(member => binarySignaled(asObject(member), is30));
}

function resolvedMultipartItems(schema: Record<string, unknown>): Record<string, unknown> | null {
  const candidates: Record<string, unknown>[] = [];
  const direct = asObject(schema.items);
  if (direct !== null) candidates.push(direct);
  if (Array.isArray(schema.allOf)) {
    for (const member of schema.allOf) {
      const nested = asObject(member);
      if (nested === null) continue;
      const items = resolvedMultipartItems(nested);
      if (items !== null) candidates.push(items);
    }
  }
  if (candidates.length === 0) return null;
  return candidates.length === 1 ? candidates[0]! : { allOf: candidates };
}

/**
 * The 3.1 schema's declared contentEncoding (3.0 has no equivalent
 * keyword; its binary signal carries no encoding).
 */
function declaredContentEncoding(schema: Record<string, unknown> | null, is30: boolean): string {
  if (is30) return "";
  if (typeof schema?.contentEncoding === "string") return schema.contentEncoding;
  if (Array.isArray(schema?.allOf)) {
    for (const member of schema.allOf) {
      const encoding = declaredContentEncoding(asObject(member), false);
      if (encoding) return encoding;
    }
  }
  return "";
}

function declaredContentMediaType(schema: Record<string, unknown> | null): string {
  if (typeof schema?.contentMediaType === "string") return schema.contentMediaType;
  if (Array.isArray(schema?.allOf)) {
    for (const member of schema.allOf) {
      const mediaType = declaredContentMediaType(asObject(member));
      if (mediaType) return mediaType;
    }
  }
  return "";
}

/** Resolves one string-valued schema keyword through allOf and refuses conflicts. */
function resolvedSchemaStringKeyword(
  schema: Record<string, unknown> | null,
  keyword: "contentEncoding" | "contentMediaType",
): string {
  const values = new Set<string>();
  collectSchemaStringKeyword(schema, keyword, values, new Set());
  if (values.size > 1) {
    throw new Error(
      `request schema has conflicting ${keyword} declarations: ${[...values].sort().map((value) => JSON.stringify(value)).join(", ")}`,
    );
  }
  return values.values().next().value ?? "";
}

function collectSchemaStringKeyword(
  schema: Record<string, unknown> | null,
  keyword: "contentEncoding" | "contentMediaType",
  values: Set<string>,
  seen: Set<Record<string, unknown>>,
): void {
  if (schema === null || seen.has(schema)) return;
  seen.add(schema);
  const direct = schema[keyword];
  if (typeof direct === "string" && direct !== "") values.add(direct);
  if (Array.isArray(schema.allOf)) {
    for (const member of schema.allOf) {
      collectSchemaStringKeyword(asObject(member), keyword, values, seen);
    }
  }
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
  canonicalBase64 = false,
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
      if (canonicalBase64) {
        try {
          return decodeBoundaryBase64(value, `multipart part ${JSON.stringify(name)}`);
        } catch {
          throw new Error(`binary part ${JSON.stringify(name)}: invalid canonical base64`);
        }
      }
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
  revision3 = false,
  openapiVersion = "3.0",
  dynamicProperties = false,
): string {
  const encoding = (media?.encoding ?? {}) as Record<string, Record<string, unknown>>;
  if (revision3) {
    return buildRevision3URLEncodedBody(media, fields, openapiVersion, dynamicProperties);
  }
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

function buildRevision3URLEncodedBody(
  media: OpenAPIMediaType | null,
  fields: Record<string, unknown>,
  openapiVersion: string,
  dynamicProperties: boolean,
): string {
  const rawSchema = mediaSchema(media);
  const schema = rawSchema && typeof rawSchema === "object" ? rawSchema : null;
  const properties = resolvedMultipartProperties(schema, new Set());
  const encoding = asObject(media?.encoding) ?? {};
  const units: string[] = [];
  for (const name of Object.keys(fields).sort()) {
    const property = dynamicProperties
      ? resolvedMultipartProperty(schema, name, new Set())
      : asObject(properties[name]);
    if (property === null) {
      throw new Error(`urlencoded property ${JSON.stringify(name)} has no declaration-defined carriage`);
    }
    const enc = asObject(encoding[name]);
    if (legacyOpenAPIFormEncoding(openapiVersion) || hasExplicitMultipartExpansion(enc)) {
      const style = typeof enc?.style === "string" && enc.style !== "" ? enc.style : "form";
      const explode = typeof enc?.explode === "boolean" ? enc.explode : style === "form";
      try {
        units.push(...serializeQueryValue(
          name,
          fields[name],
          style,
          explode,
          enc?.allowReserved === true,
          true,
          true,
        ));
      } catch (error: unknown) {
        throw new Error(
          `urlencoded property ${JSON.stringify(name)}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      continue;
    }

    const selected = typeof enc?.contentType === "string"
      ? parseSingleMultipartContentType(enc.contentType, name)
      : parseMediaType(defaultMultipartContentType(property, openapiVersion.startsWith("3.0")), true);
    requireSupportedCharset(selected, `urlencoded property ${JSON.stringify(name)}`);
    let text: string;
    const encodedString = !openapiVersion.startsWith("3.0")
      && schemaTypeIs(property, "string")
      && resolvedSchemaStringKeyword(property, "contentEncoding") !== "";
    if (encodedString) {
      if (typeof fields[name] !== "string") {
        throw new Error(`urlencoded property ${JSON.stringify(name)} requires an artifact-encoded string`);
      }
      text = fields[name];
    } else if (isJSONMediaType(selected.base)) {
      text = JSON.stringify(fields[name] ?? null);
    } else if (selected.base === "text/plain") {
      text = primitiveString(fields[name]);
    } else {
      throw new Error(
        `urlencoded property ${JSON.stringify(name)} has no serializer for ${selected.canonical}`,
      );
    }
    const bytes = encodeTextForMedia(text, selected.canonical, `urlencoded property ${JSON.stringify(name)}`);
    units.push(`${formEncodeBytes(new TextEncoder().encode(name))}=${formEncodeBytes(bytes)}`);
  }
  return units.join("&");
}

function formEncodeBytes(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) {
    if (
      (byte >= 0x41 && byte <= 0x5a)
      || (byte >= 0x61 && byte <= 0x7a)
      || (byte >= 0x30 && byte <= 0x39)
      || byte === 0x2a
      || byte === 0x2d
      || byte === 0x2e
      || byte === 0x5f
    ) {
      result += String.fromCharCode(byte);
    } else if (byte === 0x20) {
      result += "+";
    } else {
      result += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return result;
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
export function successMediaTypes(
  op: OpenAPIOperation | null | undefined,
  revision3 = false,
  responseFidelity = false,
): string[] {
  if (!op?.responses) return [];
  const seen = new Map<string, string>();
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
        const parsed = parseMediaType(mt, revision3);
        if (!seen.has(parsed.identity)) seen.set(parsed.identity, parsed.canonical);
      } catch {
        if (revision3 && responseFidelity) {
          try {
            const parsed = parseMediaRange(mt, true);
            if (!seen.has(parsed.identity)) seen.set(parsed.identity, parsed.canonical);
          } catch { /* malformed keys are handled when they govern */ }
        }
      }
    }
  }
  return [...seen.values()].sort();
}

/**
 * Advertises the declared concrete media types of the operation's success
 * responses. No declaration means no invented Accept preference.
 */
export function acceptHeader(
  op: OpenAPIOperation,
  revision3 = false,
  responseFidelity = false,
): string {
  const types = successMediaTypes(op, revision3, responseFidelity);
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
    const response = responses[key];
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
  revision3 = false,
  responseFidelity = false,
): string | null {
  return governingResponseMediaMatch(
    response,
    actualContentType,
    revision3,
    responseFidelity,
  )?.declared.canonical ?? null;
}

export interface GoverningResponseMediaMatch {
  mediaKey: string;
  declared: ParsedMediaType | ParsedMediaRange;
  media: OpenAPIMediaType;
}

/**
 * Selects the governing Media Type Object as well as its parsed declaration.
 * Revision 4 lets an actual concrete Content-Type instantiate an artifact-
 * declared range; earlier revisions inventory ranges only for collision
 * detection and never select them.
 */
export function governingResponseMediaMatch(
  response: OpenAPIResponse,
  actualContentType: string | null,
  revision3 = false,
  responseFidelity = false,
): GoverningResponseMediaMatch | null {
  const content = response.content ?? {};
  if (Object.keys(content).length === 0) return null;
  if (!actualContentType) {
    throw new Error("response declaration has content alternatives but the response omits Content-Type");
  }
  const actual = parseMediaType(actualContentType, revision3);
  const matches: Array<{
    mediaKey: string;
    declared: ParsedMediaType | ParsedMediaRange;
    media: OpenAPIMediaType;
    rangeSpecificity: number;
    parameterSpecificity: number;
  }> = [];
  const identities = new Map<string, string>();
  for (const [key, media] of Object.entries(content)) {
    let declared: ParsedMediaType | ParsedMediaRange;
    let rangeSpecificity = 2;
    try {
      declared = parseMediaType(key, revision3);
    } catch (error: unknown) {
      if (revision3) {
        try {
          const parsedRange = parseMediaRange(key, true);
          declared = parsedRange;
          rangeSpecificity = parsedRange.specificity;
        } catch (_rangeError: unknown) {
          // Preserve the concrete parse failure for a malformed declaration.
          throw error;
        }
      } else {
        throw error;
      }
    }
    if (revision3) {
      const previous = identities.get(declared.identity);
      if (previous !== undefined) {
        throw new Error(
          `response content declarations ${JSON.stringify(previous)} and ${JSON.stringify(key)} denote the same parsed media declaration (normalized collision)`,
        );
      }
      identities.set(declared.identity, key);
    }
    if (rangeSpecificity < 2 && !responseFidelity) continue;
    if (rangeSpecificity === 2) {
      if (declared.base !== actual.base) continue;
    } else if (!mediaRangeMatches(declared as ParsedMediaRange, actual)) {
      continue;
    }
    if (Object.entries(declared.params).every(([name, value]) => actual.params[name] === value)) {
      matches.push({
        mediaKey: key,
        declared,
        media,
        rangeSpecificity,
        parameterSpecificity: Object.keys(declared.params).length,
      });
    }
  }
  if (matches.length === 0) {
    throw new Error(
      `response Content-Type ${JSON.stringify(actualContentType)} matches no media declaration in the governing Response Object`,
    );
  }
  matches.sort((a, b) => b.rangeSpecificity - a.rangeSpecificity
    || b.parameterSpecificity - a.parameterSpecificity
    || a.declared.identity.localeCompare(b.declared.identity));
  if (
    matches.length > 1
    && matches[0]?.rangeSpecificity === matches[1]?.rangeSpecificity
    && matches[0]?.parameterSpecificity === matches[1]?.parameterSpecificity
  ) {
    throw new Error(
      `response Content-Type ${JSON.stringify(actualContentType)} ambiguously matches equally specific media declarations`,
    );
  }
  const selected = matches[0];
  return selected
    ? { mediaKey: selected.mediaKey, declared: selected.declared, media: selected.media }
    : null;
}

/**
 * The §8 static capability: an operation is streaming-capable iff
 * text/event-stream appears among the declared media types of its success
 * responses.
 */
export function isStreamingCapable(
  op: OpenAPIOperation,
  revision3 = false,
  responseFidelity = false,
): boolean {
  const media = successMediaTypes(op, revision3, responseFidelity);
  if (!revision3) return media.includes("text/event-stream");
  return media.some((value) => {
    try { return parseMediaType(value, true).base === "text/event-stream"; } catch {
      if (!responseFidelity) return false;
      try {
        const range = parseMediaRange(value, true);
        // Static capability asks whether some concrete event-stream response
        // could satisfy the declaration. Declaration parameters constrain the
        // eventual response, but do not make that possibility disappear.
        return range.base === "text/*" || range.base === "*/*";
      } catch { return false; }
    }
  });
}

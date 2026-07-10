import type { OBInterface, Transform, TransformOrRef } from "./types.js";
import { isTransformRef } from "./types.js";
import {
  isValidSemver,
  isHigherMajorOrPre1MinorThanMaxTested,
  isLowerThanMinSupported,
  isUnsupportedPrerelease,
  MAX_TESTED_VERSION,
  MIN_SUPPORTED_VERSION,
} from "./version.js";
import { ValidationError } from "./errors.js";
import { validateAgainstOBISchema, validateExamplesAgainstOpSchemas } from "./schema-validation.js";

export interface ValidateOptions {
  rejectUnknownTypedFields?: boolean;
}

const KNOWN_INTERFACE_FIELDS = new Set([
  "openbindings", "name", "version", "description",
  "schemas", "operations",
  "sources", "bindings", "transforms",
]);

const KNOWN_OPERATION_FIELDS = new Set([
  "description", "deprecated", "tags", "aliases",
  "idempotent", "input", "output", "examples",
]);

const KNOWN_SOURCE_FIELDS = new Set(["format", "location", "content", "description", "preference"]);
const KNOWN_BINDING_FIELDS = new Set([
  "operation", "source", "ref", "preference", "description", "deprecated",
  "inputTransform", "outputTransform",
]);
const KNOWN_EXAMPLE_FIELDS = new Set(["description", "input", "output"]);

// OBI-D-03 identifier pattern: every map key and operation alias must match.
const IDENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

const DRAFT_2020_12_URI = "https://json-schema.org/draft/2020-12/schema";

// JSON Schema 2020-12 keywords whose values are { name -> schema } maps.
const SCHEMA_MAP_KEYWORDS = new Set([
  "properties", "patternProperties", "$defs", "definitions", "dependentSchemas",
]);

// JSON Schema 2020-12 keywords whose value is itself a schema.
const SINGLE_SCHEMA_KEYWORDS = new Set([
  "additionalProperties", "propertyNames", "unevaluatedProperties",
  "items", "contains", "unevaluatedItems",
  "not", "if", "then", "else", "contentSchema",
]);

// JSON Schema 2020-12 keywords whose value is an array of schemas.
const ARRAY_SCHEMA_KEYWORDS = new Set([
  "allOf", "anyOf", "oneOf", "prefixItems",
]);

// URI-reference allowed octets per RFC 3986: unreserved + reserved.
// Percent-encoded octets are validated separately. Anything outside this set
// (whitespace, `, <, >, |, \, {, }, ", ^) makes the reference malformed.
const URI_REF_ALLOWED = (() => {
  const set = new Set<number>();
  for (let c = 0x41; c <= 0x5a; c++) set.add(c); // A-Z
  for (let c = 0x61; c <= 0x7a; c++) set.add(c); // a-z
  for (let c = 0x30; c <= 0x39; c++) set.add(c); // 0-9
  for (const ch of "-._~:/?#[]@!$&'()*+,;=") set.add(ch.charCodeAt(0));
  return set;
})();

/**
 * Performs shape-level validation checks on an OBInterface.
 * Throws {@link ValidationError} if problems are found.
 *
 * Unconditionally enforces OBI-D-12 (openbindings field is a valid SemVer
 * 2.0.0 string) and OBI-T-04 (refuse versions outside the supported range in
 * EITHER direction: a higher major — or, pre-1.0, a higher minor — than
 * MAX_TESTED_VERSION, and likewise anything below MIN_SUPPORTED_VERSION;
 * processing a document under the wrong version's rules misreads it both
 * ways).
 */
export function validateInterface(
  iface: OBInterface,
  opts: ValidateOptions = {},
): void {
  const errs: string[] = [];

  // OBI-D-12: openbindings field MUST be a valid SemVer 2.0.0 string.
  // OBI-T-04: refuse higher major (or pre-1.0 higher minor) than MaxTested.
  const ver = (iface.openbindings ?? "").trim();
  if (!ver) {
    errs.push("openbindings: required (OBI-D-12)");
  } else if (!isValidSemver(ver)) {
    errs.push(`openbindings: "${ver}" is not a valid SemVer 2.0.0 string (OBI-D-12)`);
  } else {
    try {
      if (isHigherMajorOrPre1MinorThanMaxTested(ver)) {
        errs.push(`openbindings: "${ver}" exceeds this SDK's MaxTestedVersion "${MAX_TESTED_VERSION}" (OBI-T-04)`);
      } else if (isLowerThanMinSupported(ver)) {
        errs.push(`openbindings: "${ver}" is below this SDK's MinSupportedVersion "${MIN_SUPPORTED_VERSION}" (OBI-T-04)`);
      } else if (isUnsupportedPrerelease(ver)) {
        errs.push(`openbindings: "${ver}" is a pre-release this SDK does not declare support for (OBI-T-04)`);
      }
    } catch (err) {
      errs.push(`openbindings: ${(err as Error).message} (OBI-T-04)`);
    }
  }

  // Validate schemas: keys match identifier pattern (OBI-D-03); each schema
  // walked for OBI-D-05 ($ref URI), OBI-D-06 ($schema dialect), OBI-D-07 (no
  // $vocabulary).
  if (iface.schemas) {
    for (const k of Object.keys(iface.schemas).sort()) {
      validateIdent(errs, "schemas key", k);
      walkSchema(errs, `schemas["${k}"]`, iface.schemas[k]);
    }
  }

  if (!iface.operations) {
    errs.push("operations: required");
  }

  const opKeys = Object.keys(iface.operations ?? {}).sort();
  const aliasOwner = new Map<string, string>();
  const opKeySet = new Set(opKeys);

  for (const k of opKeys) {
    const op = iface.operations[k];

    // OBI-D-03: operation keys must match the identifier pattern.
    validateIdent(errs, "operations key", k);

    // Alias checks (OBI-D-03 pattern; OBI-D-04 collisions including dup
    // within own array and alias equal to own key).
    const seenAlias = new Set<string>();
    for (const a of op.aliases ?? []) {
      if (!a.trim()) {
        errs.push(`operations["${k}"].aliases: must not contain empty strings`);
        continue;
      }
      validateIdent(errs, `operations["${k}"].aliases`, a);
      if (a === k) {
        errs.push(`operations["${k}"].aliases: "${a}" duplicates the operation's own key (OBI-D-04)`);
        continue;
      }
      if (seenAlias.has(a)) {
        errs.push(`operations["${k}"].aliases: "${a}" is listed more than once (OBI-D-04)`);
        continue;
      }
      seenAlias.add(a);
      if (opKeySet.has(a)) {
        errs.push(`operations["${k}"].aliases: "${a}" conflicts with operation key "${a}" (OBI-D-04)`);
        continue;
      }
      const owner = aliasOwner.get(a);
      if (owner && owner !== k) {
        errs.push(`operations["${k}"].aliases: "${a}" is also an alias of "${owner}" (OBI-D-04)`);
        continue;
      }
      aliasOwner.set(a, k);
    }


    // Walk operation input/output schemas for OBI-D-05/D-07/D-08.
    if (op.input != null) {
      walkSchema(errs, `operations["${k}"].input`, op.input);
    }
    if (op.output != null) {
      walkSchema(errs, `operations["${k}"].output`, op.output);
    }

    // OBI-D-03: example keys must match the identifier pattern.
    for (const ek of Object.keys(op.examples ?? {}).sort()) {
      validateIdent(errs, `operations["${k}"].examples key`, ek);
    }

    if (opts.rejectUnknownTypedFields) {
      appendUnknown(errs, `operations["${k}"]`, op, KNOWN_OPERATION_FIELDS);
      for (const [ek, ex] of Object.entries(op.examples ?? {})) {
        appendUnknown(errs, `operations["${k}"].examples["${ek}"]`, ex, KNOWN_EXAMPLE_FIELDS);
      }
    }
  }

  for (const k of Object.keys(iface.sources ?? {}).sort()) {
    // OBI-D-03: source keys must match the identifier pattern.
    validateIdent(errs, "sources key", k);
    const src = iface.sources![k];
    // The spec (§6.4) requires format to be a non-empty string but
    // deliberately does not constrain its syntax; rejecting unrecognized
    // format spellings at document level would violate OBI-T-01.
    const fmtVal = (src.format ?? "").trim();
    if (!fmtVal) {
      errs.push(`sources["${k}"].format: required`);
    }
    const hasLoc = !!(src.location ?? "").trim();
    const hasCnt = src.content != null;
    if (!hasLoc && !hasCnt) errs.push(`sources["${k}"]: must have location or content`);
    // OBI-D-05: sources[*].location must be a well-formed, absolute reference
    // (absolute URI or a format-defined absolute address; never relative).
    if (hasLoc) {
      validateURIRef(errs, `sources["${k}"].location`, src.location!);
      if (!referenceIsAbsolute(src.location!)) {
        errs.push(`sources["${k}"].location: "${src.location}" must be an absolute URI or a format-defined absolute address, not a relative reference (OBI-D-05); a local artifact can be embedded as the source's content instead (a file:// URL is machine-coupled and resolves only on the authoring machine)`);
      }
    }
    if (opts.rejectUnknownTypedFields) {
      appendUnknown(errs, `sources["${k}"]`, src, KNOWN_SOURCE_FIELDS);
    }
  }

  for (const k of Object.keys(iface.transforms ?? {}).sort()) {
    // OBI-D-03: transform keys must match the identifier pattern.
    validateIdent(errs, "transforms key", k);
    validateInlineTransform(errs, `transforms["${k}"]`, iface.transforms![k]);
  }

  for (const k of Object.keys(iface.bindings ?? {}).sort()) {
    // OBI-D-03: binding keys must match the identifier pattern.
    validateIdent(errs, "bindings key", k);
    const b = iface.bindings![k];
    // OBI-D-08: bindings[*].operation must reference an existing operation.
    if (!(b.operation ?? "").trim()) {
      errs.push(`bindings["${k}"].operation: required`);
    } else if (!iface.operations?.[b.operation]) {
      errs.push(`bindings["${k}"].operation: references unknown operation "${b.operation}" (OBI-D-08)`);
    }
    // OBI-D-09: bindings[*].source must reference an existing source.
    if (!(b.source ?? "").trim()) {
      errs.push(`bindings["${k}"].source: required`);
    } else if (!iface.sources?.[b.source]) {
      errs.push(`bindings["${k}"].source: references unknown source "${b.source}" (OBI-D-09)`);
    }

    if (b.inputTransform !== undefined) {
      if (isTransformRef(b.inputTransform)) {
        validateTransformRef(errs, `bindings["${k}"].inputTransform.$ref`, b.inputTransform.$ref, iface.transforms);
      } else {
        validateInlineTransform(errs, `bindings["${k}"].inputTransform`, b.inputTransform);
      }
    }
    if (b.outputTransform !== undefined) {
      if (isTransformRef(b.outputTransform)) {
        validateTransformRef(errs, `bindings["${k}"].outputTransform.$ref`, b.outputTransform.$ref, iface.transforms);
      } else {
        validateInlineTransform(errs, `bindings["${k}"].outputTransform`, b.outputTransform);
      }
    }

    if (opts.rejectUnknownTypedFields) {
      appendUnknown(errs, `bindings["${k}"]`, b, KNOWN_BINDING_FIELDS);
    }
  }

  if (opts.rejectUnknownTypedFields) {
    appendUnknown(errs, "", iface, KNOWN_INTERFACE_FIELDS);
  }

  // OBI-D-02: validate the document against openbindings.schema.json.
  validateAgainstOBISchema(errs, iface);

  // OBI-D-11: validate every example.input/output against its
  // operation's input/output schema, when the respective schema is specified.
  validateExamplesAgainstOpSchemas(errs, iface);

  if (errs.length > 0) throw new ValidationError(errs);
}

function appendUnknown(
  errs: string[],
  prefix: string,
  obj: Record<string, unknown>,
  known: Set<string>,
): void {
  const unknown = Object.keys(obj).filter(
    (k) => !known.has(k) && !k.startsWith("x-"),
  );
  if (unknown.length === 0) return;
  unknown.sort();
  const msg = `unknown fields: ${unknown.join(", ")}`;
  errs.push(prefix ? `${prefix}: ${msg}` : msg);
}

function validateTransformRef(
  errs: string[],
  prefix: string,
  ref: string,
  transforms?: Record<string, Transform>,
): void {
  const pfx = "#/transforms/";
  if (!ref.startsWith(pfx)) {
    errs.push(`${prefix}: must start with "${pfx}" (OBI-D-10)`);
    return;
  }
  const name = ref.slice(pfx.length);
  if (!name) {
    errs.push(`${prefix}: transform name is empty (OBI-D-10)`);
    return;
  }
  if (transforms?.[name] === undefined) {
    errs.push(`${prefix}: references unknown transform "${name}" (OBI-D-10)`);
  }
}

function validateInlineTransform(
  errs: string[],
  prefix: string,
  expr: TransformOrRef,
): void {
  // Per v0.2 spec §6.5, inline transforms are JSONata 2.0 expression
  // strings. No document rule constrains the expression's content (an empty
  // string is schema-valid); evaluation failures, including empty
  // expressions, surface at invoke time per OBI-T-10
  // (EmptyTransformExpressionError / ERR_TRANSFORM_ERROR).
  if (typeof expr !== "string") {
    errs.push(`${prefix}: must be a JSONata expression string or a $ref object`);
  }
}

function validateIdent(errs: string[], prefix: string, id: string): void {
  if (!IDENT_PATTERN.test(id)) {
    errs.push(`${prefix}: "${id}" does not match identifier pattern ^[A-Za-z_][A-Za-z0-9_.-]*$ (OBI-D-03)`);
  }
}

function isHex(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
}

function validateURIRef(errs: string[], prefix: string, raw: string): void {
  if (!raw) return;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 0x25 /* % */) {
      if (i + 2 >= raw.length || !isHex(raw.charCodeAt(i + 1)) || !isHex(raw.charCodeAt(i + 2))) {
        errs.push(`${prefix}: "${raw}" contains malformed percent-encoding (OBI-D-05)`);
        return;
      }
      i += 2;
      continue;
    }
    if (!URI_REF_ALLOWED.has(c)) {
      errs.push(`${prefix}: "${raw}" contains character "${raw[i]}" not allowed in a URI reference (OBI-D-05)`);
      return;
    }
  }
  // Best-effort structural parse. URL constructor requires a base for relative
  // refs; use a placeholder so we accept relative URIs (RFC 3986 §4.1).
  try {
    new URL(raw, "http://example.com/");
  } catch {
    errs.push(`${prefix}: "${raw}" is not a well-formed URI reference (OBI-D-05)`);
  }
}

// referenceIsAbsolute reports whether raw is an absolute reference for OBI-D-05
// purposes: an absolute URI (has a scheme) or a format-defined absolute address
// (e.g. a gRPC host:port, which parses with a scheme). Same-document fragments
// and relative-path references are not absolute.
function referenceIsAbsolute(raw: string): boolean {
  try {
    new URL(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walks a JSON Schema 2020-12 value and applies:
 *   - OBI-D-06: $schema, where present, MUST equal the 2020-12 dialect URI.
 *   - OBI-D-07: $vocabulary keyword forbidden anywhere in any schema.
 *   - OBI-D-05: $ref and $id values MUST be absolute or same-document and well-formed.
 *
 * Recursion follows JSON Schema keyword shapes so that property names under
 * `properties`/`patternProperties`/`$defs`/etc. are not themselves treated
 * as schema keywords.
 */
function walkSchema(errs: string[], prefix: string, schema: unknown): void {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return;
  }
  const s = schema as Record<string, unknown>;

  if (typeof s.$schema === "string" && s.$schema !== DRAFT_2020_12_URI) {
    errs.push(`${prefix}.$schema: "${s.$schema}" must equal "${DRAFT_2020_12_URI}" (OBI-D-06)`);
  }
  if ("$vocabulary" in s) {
    errs.push(`${prefix}: $vocabulary keyword is forbidden in OBI documents (OBI-D-07)`);
  }
  if (typeof s.$ref === "string") {
    validateURIRef(errs, `${prefix}.$ref`, s.$ref);
    if (!s.$ref.startsWith("#") && !referenceIsAbsolute(s.$ref)) {
      errs.push(`${prefix}.$ref: "${s.$ref}" must be a same-document fragment or an absolute URI, not a relative reference (OBI-D-05)`);
    } else if (s.$ref.startsWith("#") && s.$ref !== "#" && !s.$ref.startsWith("#/")) {
      errs.push(`${prefix}.$ref: "${s.$ref}" is a plain-name fragment; a same-document schema $ref is a JSON Pointer fragment (bare # or #/...), and the schemas map is the document's named-schema mechanism (OBI-D-05)`);
    }
  }
  if (typeof s.$id === "string" && !referenceIsAbsolute(s.$id)) {
    errs.push(`${prefix}.$id: "${s.$id}" must be an absolute URI (OBI-D-05)`);
  }

  for (const k of Object.keys(s).sort()) {
    const v = s[k];
    if (SCHEMA_MAP_KEYWORDS.has(k)) {
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        const m = v as Record<string, unknown>;
        for (const sk of Object.keys(m).sort()) {
          walkSchema(errs, `${prefix}.${k}.${sk}`, m[sk]);
        }
      }
    } else if (SINGLE_SCHEMA_KEYWORDS.has(k)) {
      walkSchema(errs, `${prefix}.${k}`, v);
    } else if (ARRAY_SCHEMA_KEYWORDS.has(k)) {
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          walkSchema(errs, `${prefix}.${k}[${i}]`, v[i]);
        }
      }
    }
  }
}

import type { OBInterface, Transform, TransformOrRef } from "./types.js";
import { isTransformRef } from "./types.js";
import { isValidSemver, versionRefusalReason } from "./version.js";
import { ValidationError } from "./errors.js";
import {
  validateAgainstOBISchema,
  validateExamplesAgainstOpSchemas,
  validateSchemaWellFormedness,
} from "./schema-validation.js";
import jsonata from "jsonata";

export interface ValidateOptions {
  rejectUnknownTypedFields?: boolean;
}

const KNOWN_INTERFACE_FIELDS = new Set([
  "openbindings", "name", "version", "description",
	"schemas", "operations",
	"dependencies", "sources", "bindings", "transforms",
]);

const KNOWN_OPERATION_FIELDS = new Set([
  "description", "deprecated", "tags", "aliases",
  "idempotent", "input", "output", "examples",
]);

const KNOWN_SOURCE_FIELDS = new Set(["bindingSpec", "location", "content", "description"]);
const KNOWN_DEPENDENCY_FIELDS = new Set(["operation", "bindingSpecs"]);
const KNOWN_BINDING_FIELDS = new Set([
  "operation", "source", "selector", "preference", "description", "deprecated",
  "inputTransform", "outputTransform",
]);
const KNOWN_EXAMPLE_FIELDS = new Set(["description", "input", "output"]);

// OBI-D-03 identifier pattern: every map key and operation alias must match.
// The grammar permits a leading digit (2fa.verify): names are opaque data
// labels, not host-language identifiers, so only the start character is
// constrained to an alphanumeric or underscore.
const IDENT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

const DRAFT_2020_12_URI = "https://json-schema.org/draft/2020-12/schema";

// Entries of a possibly-absent map in ascending key order. The comparator is
// code-unit `<`/`>` — the same ordering as Object.keys(map).sort() — so error
// output is byte-identical to the keys-then-index form this replaces, while
// iterating entries keeps each value typed as present.
function sortedEntries<T>(map: Record<string, T> | undefined): [string, T][] {
  return Object.entries(map ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

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
      const reason = versionRefusalReason(ver);
      if (reason) errs.push(`openbindings: ${reason} (OBI-T-04)`);
    } catch (err) {
      errs.push(`openbindings: ${(err as Error).message} (OBI-T-04)`);
    }
  }

  // Validate schemas: keys match identifier pattern (OBI-D-03); each schema
  // checked for well-formedness against the 2020-12 meta-schemas (OBI-D-17)
  // and walked for OBI-D-05 ($ref URI), OBI-D-06 ($schema dialect), OBI-D-07
  // (no $vocabulary).
  for (const [k, schema] of sortedEntries(iface.schemas)) {
    validateIdent(errs, "schemas key", k);
    validateSchemaWellFormedness(errs, `schemas["${k}"]`, schema);
    walkSchema(errs, `schemas["${k}"]`, schema, iface, false);
  }

  if (!iface.operations) {
    errs.push("operations: required");
  }

  const opEntries = sortedEntries(iface.operations);
  const aliasOwner = new Map<string, string>();
  const opKeySet = new Set(opEntries.map(([k]) => k));

  for (const [k, op] of opEntries) {
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


    // Check operation input/output schemas for well-formedness (OBI-D-17)
    // and walk them for OBI-D-05/D-06/D-07/D-16.
    if (op.input != null) {
      validateSchemaWellFormedness(errs, `operations["${k}"].input`, op.input);
      walkSchema(errs, `operations["${k}"].input`, op.input, iface, false);
    }
    if (op.output != null) {
      validateSchemaWellFormedness(errs, `operations["${k}"].output`, op.output);
      walkSchema(errs, `operations["${k}"].output`, op.output, iface, false);
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

  for (const [k, dependency] of sortedEntries(iface.dependencies)) {
		validateIdent(errs, "dependencies key", k);
		if (!dependency || typeof dependency !== "object" || Array.isArray(dependency)) continue;
    if (typeof dependency.operation !== "string" || !dependency.operation.trim()) {
      errs.push(`dependencies["${k}"].operation: required`);
    } else if (!iface.operations || !Object.hasOwn(iface.operations, dependency.operation)) {
			errs.push(
				`dependencies["${k}"].operation: references unknown operation ${JSON.stringify(dependency.operation)} (OBI-D-19)`,
			);
		}
    if (opts.rejectUnknownTypedFields) {
      appendUnknown(errs, `dependencies["${k}"]`, dependency, KNOWN_DEPENDENCY_FIELDS);
    }
  }

  for (const [k, src] of sortedEntries(iface.sources)) {
    // OBI-D-03: source keys must match the identifier pattern.
    validateIdent(errs, "sources key", k);
    // The spec requires bindingSpec to be a non-empty string but
    // deliberately does not constrain its syntax; identifiers are exact and
    // opaque (core §6), and rejecting unrecognized spellings at document
    // level would violate OBI-T-01.
    if (!(src.bindingSpec ?? "").trim()) {
      errs.push(`sources["${k}"].bindingSpec: required`);
    }
    const hasLoc = !!(src.location ?? "").trim();
    // Member presence, not value: `content: null` is a PRESENT member
    // (core §7) and satisfies the location-or-content requirement.
    const hasCnt = src.content !== undefined;
    if (!hasLoc && !hasCnt) errs.push(`sources["${k}"]: must have location or content`);
    // OBI-D-05: sources[*].location must be a well-formed, absolute reference
    // (absolute URI or a bindingSpec-defined absolute address; never relative).
    if (hasLoc) {
      validateLocation(errs, `sources["${k}"].location`, src.location!);
    }
    if (opts.rejectUnknownTypedFields) {
      appendUnknown(errs, `sources["${k}"]`, src, KNOWN_SOURCE_FIELDS);
    }
  }

  // OBI-D-18: every value in the transforms map parses as a syntactically
  // valid expression of the pinned transform language (JSONata 2.1,
  // jsonata-js 2.1.1 parse-acceptance tiebreak). Parse-only: evaluation
  // failures (undefined results, dynamic errors) remain invoke-time
  // outcomes per OBI-T-10 / ERR_TRANSFORM_ERROR.
  for (const [k, transform] of sortedEntries(iface.transforms)) {
    // OBI-D-03: transform keys must match the identifier pattern.
    validateIdent(errs, "transforms key", k);
    validateInlineTransform(errs, `transforms["${k}"]`, transform);
  }

  for (const [k, b] of sortedEntries(iface.bindings)) {
    // OBI-D-03: binding keys must match the identifier pattern.
    validateIdent(errs, "bindings key", k);
    // OBI-D-08: bindings[*].operation must reference an existing operation.
    // The lookup is own-property only: document-supplied keys such as
    // "constructor"/"toString" must resolve against the document's own map,
    // never a JS object's prototype chain (which would validate a dangling
    // reference clean — a false negative at the trust boundary).
    if (!(b.operation ?? "").trim()) {
      errs.push(`bindings["${k}"].operation: required`);
    } else if (!iface.operations || !Object.hasOwn(iface.operations, b.operation)) {
      errs.push(`bindings["${k}"].operation: references unknown operation "${b.operation}" (OBI-D-08)`);
    }
    // OBI-D-09: bindings[*].source must reference an existing source (own
    // property only, per the OBI-D-08 note above).
    if (!(b.source ?? "").trim()) {
      errs.push(`bindings["${k}"].source: required`);
    } else if (!iface.sources || !Object.hasOwn(iface.sources, b.source)) {
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
  // Own property only: a named-transform key such as "constructor" must
  // resolve against the document's own transforms map, never a JS object's
  // prototype chain.
  if (!transforms || !Object.hasOwn(transforms, name)) {
    errs.push(`${prefix}: references unknown transform "${name}" (OBI-D-10)`);
  }
}

function validateInlineTransform(
  errs: string[],
  prefix: string,
  expr: TransformOrRef,
): void {
  // Per §5.5, transforms are JSONata expression strings. OBI-D-18: every
  // transform expression parses as a syntactically valid expression of the
  // pinned language (JSONata 2.1, jsonata-js 2.1.1 parse-acceptance
  // tiebreak). Parse-only — membership in the language, not success of
  // evaluation: undefined results and dynamic errors remain invoke-time
  // outcomes per OBI-T-10 / ERR_TRANSFORM_ERROR.
  if (typeof expr !== "string") {
    errs.push(`${prefix}: must be a JSONata expression string or a $ref object`);
    return;
  }
  if (!jsonataParses(expr)) {
    errs.push(`${prefix}: not a syntactically valid JSONata expression (OBI-D-18)`);
  }
}

/**
 * Whether expr parses under the bundled JSONata parser. The parser is only
 * ever handed document-supplied strings; any thrown error is a parse
 * failure.
 */
function jsonataParses(expr: string): boolean {
  try {
    jsonata(expr);
    return true;
  } catch {
    return false;
  }
}

function validateIdent(errs: string[], prefix: string, id: string): void {
  if (!IDENT_PATTERN.test(id)) {
    errs.push(`${prefix}: "${id}" does not match identifier pattern ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ (OBI-D-03)`);
  }
}

function isHex(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
}

// screenURIChars reports whether raw contains only characters permitted in a
// URI reference per RFC 3986, with well-formed percent-encoding. On the first
// violation it appends an error and returns false. URL parsers are too
// permissive (they accept or encode whitespace, backticks, and angle
// brackets), so this screen runs before any structural parse.
function screenURIChars(errs: string[], prefix: string, raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 0x25 /* % */) {
      if (i + 2 >= raw.length || !isHex(raw.charCodeAt(i + 1)) || !isHex(raw.charCodeAt(i + 2))) {
        errs.push(`${prefix}: "${raw}" contains malformed percent-encoding (OBI-D-05)`);
        return false;
      }
      i += 2;
      continue;
    }
    if (!URI_REF_ALLOWED.has(c)) {
      errs.push(`${prefix}: "${raw}" contains character "${raw[i]}" not allowed in a URI reference (OBI-D-05)`);
      return false;
    }
  }
  return true;
}

function validateURIRef(errs: string[], prefix: string, raw: string): void {
  if (!raw) return;
  if (!screenURIChars(errs, prefix, raw)) return;
  // Best-effort structural parse. URL constructor requires a base for relative
  // refs; use a placeholder so we accept relative URIs (RFC 3986 §4.1).
  try {
    new URL(raw, "http://example.com/");
  } catch {
    errs.push(`${prefix}: "${raw}" is not a well-formed URI reference (OBI-D-05)`);
  }
}

// referenceIsAbsolute reports whether raw is an absolute URI (has a scheme).
// Used for schema $ref/$id, which are always URI-form: a same-document fragment
// or an absolute URI. Source locations use validateLocation instead, which also
// admits non-scheme format-defined absolute addresses such as a gRPC host:port.
function referenceIsAbsolute(raw: string): boolean {
  try {
    new URL(raw);
    return true;
  } catch {
    return false;
  }
}

// isRelativeReference reports whether raw is a relative reference per RFC 3986
// §4.2: one with no scheme and no authority, needing a base URI to resolve
// (./x, ../x, x.json, /abs/path, //host/path). The discriminator is whether a
// ':' appears before the first '/', '?', or '#'; a relative reference has none.
// Both absolute URIs (https://...) and format-defined absolute addresses
// (grpc.example.com:443, 10.0.0.1:443, [::1]:443) are therefore non-relative.
function isRelativeReference(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    switch (raw[i]) {
      case ":":
        return false;
      case "/":
      case "?":
      case "#":
        return true;
    }
  }
  return true;
}

// hasURIScheme reports whether raw begins with an RFC 3986 scheme followed by
// ':' (ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"). URI-form locations get
// the strict structural parse; a scheme-less format-defined absolute address
// (an IP-literal host:port) does not, and is left to its format to interpret.
function hasURIScheme(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (raw[i] === ":") return i > 0;
    const alpha = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
    if (i === 0) {
      if (!alpha) return false;
      continue;
    }
    const digit = c >= 0x30 && c <= 0x39;
    if (!alpha && !digit && raw[i] !== "+" && raw[i] !== "-" && raw[i] !== ".") return false;
  }
  return false;
}

// validateLocation checks OBI-D-05 for a sources[*].location: it MUST be an
// absolute URI or a format-defined absolute address (e.g. a gRPC host:port),
// never a relative reference. The character screen applies to every location;
// the strict structural parse applies only to URI-form locations (those
// carrying a URI scheme). A scheme-less format-defined absolute address (an
// IP-literal host:port like 10.0.0.1:443 or [::1]:443) is exempt from RFC
// 3986 well-formedness: its syntax is the binding format's concern, not OBI's
// (OBI-D-05, §10). referenceIsAbsolute is deliberately not reused here: it
// treats a location as absolute only when the URL parser infers a scheme, so
// it would admit a hostname:port (host misread as scheme) yet reject an
// IP-literal one.
function validateLocation(errs: string[], prefix: string, raw: string): void {
  if (!raw) return;
  if (isRelativeReference(raw)) {
    errs.push(
      `${prefix}: "${raw}" must be an absolute URI or a format-defined absolute address, not a relative reference (OBI-D-05); a local artifact can be embedded as the source's content instead (a file:// URL is machine-coupled and resolves only on the authoring machine)`,
    );
    return;
  }
  // OBI-D-05's exemption: a bindingSpec-defined absolute address (a gRPC
  // host:port, a usage exec argv vector) is well-formed per its own binding
  // specification, which the core cannot verify. The decidable
  // discriminator is the hierarchical URI form: a value whose scheme is
  // followed by "//" claims RFC 3986 URI form and is held to it; a
  // scheme-opaque non-relative value may be a bindingSpec-defined address
  // and passes core validation (per-family verification belongs to family
  // processors, per the partial-verification posture).
  if (!isHierarchicalURIForm(raw)) return;
  if (!screenURIChars(errs, prefix, raw)) return;
  try {
    new URL(raw);
  } catch {
    errs.push(`${prefix}: "${raw}" is not a well-formed URI reference (OBI-D-05)`);
  }
}

// isHierarchicalURIForm reports whether raw is scheme://... — the RFC 3986
// hierarchical form whose well-formedness the core enforces at source
// locations. Scheme-opaque values (mailto:-style, exec:argv, host:port) are
// outside it.
function isHierarchicalURIForm(raw: string): boolean {
  const i = raw.indexOf(":");
  if (i <= 0 || !hasURIScheme(raw)) return false;
  return raw.startsWith("//", i + 1);
}

/**
 * Walks a JSON Schema 2020-12 value and applies:
 *   - OBI-D-06: $schema, where present, MUST equal the 2020-12 dialect URI.
 *   - OBI-D-07: $vocabulary keyword forbidden anywhere in any schema.
 *   - OBI-D-05: $ref and $id values MUST be absolute or same-document and
 *     well-formed; $dynamicRef and $dynamicAnchor do not appear at OBI
 *     positions at all. A nested $id inside a schema that already declares
 *     one is resource-internal and exempt from the absoluteness check, per
 *     §10 clause 2.
 *
 * Recursion follows JSON Schema keyword shapes so that property names under
 * `properties`/`patternProperties`/`$defs`/etc. are not themselves treated
 * as schema keywords.
 */
/**
 * Whether an RFC 6901 JSON Pointer (the fragment with its leading # removed)
 * resolves to an existing location in the document. Existence only:
 * OBI-D-16 does not type-check the target.
 */
function docPointerResolves(doc: unknown, pointer: string): boolean {
  // Same-document OBI fragments are in literal form (§7): the pointer's
  // characters are written unencoded, so the fragment is evaluated as an
  // RFC 6901 JSON Pointer directly, with no percent-decoding. A
  // percent-encoded fragment is not a conformant OBI reference and is
  // rejected upstream by walkSchema's literal-form gate before it reaches
  // this resolver, so this function never honors that non-conformant
  // spelling. Only RFC 6901's own ~0/~1 escaping is unescaped below.
  if (pointer === "") return true; // bare # addresses the document root
  if (!pointer.startsWith("/")) return false;
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const tok = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(cur)) {
      const idx = /^\d+$/.test(tok) ? Number(tok) : -1;
      if (idx < 0 || idx >= cur.length) return false;
      cur = cur[idx];
    } else if (typeof cur === "object" && cur !== null) {
      // Own property only: a JSON Pointer token such as "constructor" must
      // address the document's own data, never a JS object's prototype chain.
      if (!Object.hasOwn(cur, tok)) return false;
      cur = (cur as Record<string, unknown>)[tok];
    } else {
      return false;
    }
  }
  return true;
}

function walkSchema(errs: string[], prefix: string, schema: unknown, doc?: unknown, inID?: boolean): void {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return;
  }
  const s = schema as Record<string, unknown>;

  // wasInID captures the incoming scope before the mutation below: it
  // distinguishes an $id at an OBI position (must be absolute, OBI-D-05)
  // from a nested $id inside a schema that already declares one (resolves
  // against that resource's base per JSON Schema 2020-12 and MAY be
  // relative — resource-internal, §10 clause 2).
  const wasInID = inID;

  // A schema that declares its own $id is a distinct schema resource: its
  // $ref (and its subtree's) resolve against that resource's base per §10,
  // so OBI-D-16's root-context resolution check does not apply inside it.
  if (typeof s.$id === "string") {
    inID = true;
  }

  if (typeof s.$schema === "string" && s.$schema !== DRAFT_2020_12_URI) {
    errs.push(`${prefix}.$schema: "${s.$schema}" must equal "${DRAFT_2020_12_URI}" (OBI-D-06)`);
  }
  if ("$vocabulary" in s) {
    errs.push(`${prefix}: $vocabulary keyword is forbidden in OBI documents (OBI-D-07)`);
  }
  // The dynamic pair does not appear at OBI positions at all: dynamic
  // resolution follows the runtime dynamic scope rather than the document
  // (§10 clause 2). Inside a schema declaring its own $id, both are that
  // resource's internal business — the same scope carve-out as $ref/$anchor.
  if (!inID) {
    if ("$dynamicRef" in s) {
      errs.push(`${prefix}: $dynamicRef does not appear at OBI positions; dynamic resolution follows the runtime dynamic scope rather than the document (OBI-D-05)`);
    }
    if ("$dynamicAnchor" in s) {
      errs.push(`${prefix}: $dynamicAnchor does not appear at OBI positions; it would be a second named-schema mechanism competing with the schemas map, as $anchor would (OBI-D-05)`);
    }
  }
  if (typeof s.$ref === "string") {
    validateURIRef(errs, `${prefix}.$ref`, s.$ref);
    if (!s.$ref.startsWith("#") && !referenceIsAbsolute(s.$ref)) {
      errs.push(`${prefix}.$ref: "${s.$ref}" must be a same-document fragment or an absolute URI, not a relative reference (OBI-D-05)`);
    } else if (s.$ref.startsWith("#") && !inID && s.$ref.includes("%")) {
      // Literal form (§7): same-document fragments are written with the
      // pointer's characters unencoded, so every addressable location has
      // exactly one conformant spelling. A percent-encoded fragment is not
      // a conformant OBI-defined reference — reported here rather than
      // silently decoded and resolved. Inside a schema declaring its own
      // $id the fragment is resource-internal and resolves per JSON Schema
      // 2020-12, so this gate is OBI-position only (!inID).
      errs.push(`${prefix}.$ref: "${s.$ref}" is not in literal form; a same-document fragment is written with the pointer's characters unencoded (percent-encoding is not a conformant OBI reference) (OBI-D-05)`);
    } else if (s.$ref.startsWith("#") && s.$ref !== "#" && !s.$ref.startsWith("#/") && !inID) {
      // Inside a schema declaring its own $id, fragments resolve against
      // that resource's base per JSON Schema — the same scope carve-out
      // as OBI-D-16.
      errs.push(`${prefix}.$ref: "${s.$ref}" is a plain-name fragment; a same-document schema $ref is a JSON Pointer fragment (bare # or #/...), and the schemas map is the document's named-schema mechanism (OBI-D-05)`);
    } else if ((s.$ref === "#" || s.$ref.startsWith("#/")) && !inID && doc !== undefined) {
      if (!docPointerResolves(doc, s.$ref.slice(1))) {
        errs.push(`${prefix}.$ref: "${s.$ref}" does not resolve within the document (OBI-D-16)`);
      }
    }
  }
  if (typeof s.$id === "string" && !wasInID && !referenceIsAbsolute(s.$id)) {
    errs.push(`${prefix}.$id: "${s.$id}" must be an absolute URI (OBI-D-05)`);
  }

  for (const k of Object.keys(s).sort()) {
    const v = s[k];
    if (SCHEMA_MAP_KEYWORDS.has(k)) {
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        const m = v as Record<string, unknown>;
        for (const sk of Object.keys(m).sort()) {
          walkSchema(errs, `${prefix}.${k}.${sk}`, m[sk], doc, inID);
        }
      }
    } else if (SINGLE_SCHEMA_KEYWORDS.has(k)) {
      walkSchema(errs, `${prefix}.${k}`, v, doc, inID);
    } else if (ARRAY_SCHEMA_KEYWORDS.has(k)) {
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          walkSchema(errs, `${prefix}.${k}[${i}]`, v[i], doc, inID);
        }
      }
    }
  }
}

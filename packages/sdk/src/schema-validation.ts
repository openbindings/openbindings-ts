/**
 * OBI-D-02 (validate document against openbindings.schema.json) and
 * OBI-D-11 (validate every example.input/output against its operation's
 * input/output schema). Also exposes helpers used by OperationInvoker
 * for OBI-T-16 runtime validation.
 *
 * Validator backend: json-schema-library. Pure ES, tree-walking, no
 * `eval` / `new Function()`. Works across the SDK's target runtimes
 * (Cloudflare Workers, Vercel Edge, Netlify Edge, Deno Deploy, Node
 * 18+, modern browsers including CSP-strict, Bun, AWS Lambda) —
 * verified by bundling probes and by the official JSON Schema test
 * suite (1287/1299 required cases; the misses are format-assertion
 * cases neutralized by the boundary draft below and cases unreachable
 * in valid OBI documents).
 *
 * The choice of validator backend is an internal implementation detail;
 * the SDK's public error and result types are stable across any future
 * swap. See STABILITY.md.
 */
import { compileSchema, draft2020 } from "json-schema-library";
import type { OBInterface } from "./types.js";
import obiSchema from "./openbindings.schema.json" with { type: "json" };
import metaSchema from "./metaschema-2020-12/schema.json" with { type: "json" };
import metaCore from "./metaschema-2020-12/meta-core.json" with { type: "json" };
import metaApplicator from "./metaschema-2020-12/meta-applicator.json" with { type: "json" };
import metaValidation from "./metaschema-2020-12/meta-validation.json" with { type: "json" };
import metaMetaData from "./metaschema-2020-12/meta-meta-data.json" with { type: "json" };
import metaFormatAnnotation from "./metaschema-2020-12/meta-format-annotation.json" with { type: "json" };
import metaContent from "./metaschema-2020-12/meta-content.json" with { type: "json" };
import metaUnevaluated from "./metaschema-2020-12/meta-unevaluated.json" with { type: "json" };

/**
 * The OBI boundary draft: JSON Schema 2020-12 with an EMPTY format
 * registry. §6.2: at OBI validation boundaries, `format` is an
 * annotation, never an assertion — emptying the registry makes the
 * backend annotation-only natively, with no schema rewriting.
 */
const OBI_BOUNDARY_DRAFT = {
  ...draft2020,
  formats: {},
  // The legacy draft-7 `dependencies` keyword is not part of 2020-12
  // (replaced by dependentSchemas/dependentRequired); an unknown keyword
  // never asserts at an OBI boundary, matching the Go backend.
  keywords: draft2020.keywords.filter((k) => k.keyword !== "dependencies"),
};

/**
 * A compiled schema ready for repeated validation. The SDK-owned
 * interface over the backend, so consumers (including the
 * operation-graph engine) never depend on the backend directly.
 */
export interface CompiledSchema {
  validate(value: unknown): { valid: boolean; failures: ValidationFailure[] };
}

/** Normalizes a jsl instance pointer ("#/a/b", "#") to Go's dialect ("/a/b", ""). */
function normalizePointer(pointer: string | undefined): string {
  if (!pointer || pointer === "#") return "";
  return pointer.startsWith("#") ? pointer.slice(1) : pointer;
}

type JslError = { message?: string; data?: { pointer?: string } };

function wrapNode(node: ReturnType<typeof compileSchema>): CompiledSchema {
  return {
    validate(value: unknown) {
      const r = node.validate(value);
      if (r.valid) return { valid: true, failures: [] };
      const failures: ValidationFailure[] = (r.errors ?? []).map((e: JslError) => ({
        path: normalizePointer(e.data?.pointer),
        message: e.message ?? "schema violation",
      }));
      return { valid: false, failures };
    },
  };
}

/** Names the JSON type of a decoded value for diagnostics (Go parity). */
function jsonTypeName(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  return typeof v;
}

/**
 * Reports OBI-D-17 violations at one schema position: the value must be a
 * JSON Schema 2020-12 schema in object or boolean form, and the object
 * form must validate against the 2020-12 meta-schemas (which cover
 * subschemas recursively; the meta-schemas are vendored locally, never
 * fetched, per the rule's verification note). The check is deliberately
 * narrow, mirroring §5.2: unknown keywords, unparseable `pattern` values,
 * and unresolvable `$ref` targets all pass — they surface when the schema
 * is used, not here.
 */
export function validateSchemaWellFormedness(
  errs: string[],
  prefix: string,
  schema: unknown,
): void {
  if (typeof schema === "boolean") return; // boolean form is always well-formed
  if (typeof schema === "object" && schema !== null && !Array.isArray(schema)) {
    const meta = metaValidator().validate(schema);
    if (!meta.valid) {
      for (const f of meta.failures) {
        const line = f.path ? `${f.path}: ${f.message}` : f.message;
        errs.push(`${prefix}: not a well-formed JSON Schema 2020-12 schema: ${line} (OBI-D-17)`);
      }
    }
    return;
  }
  errs.push(`${prefix}: a schema is a JSON Schema 2020-12 object or boolean; got ${jsonTypeName(schema)} (OBI-D-17)`);
}

let _documentValidator: CompiledSchema | null = null;

function documentValidator(): CompiledSchema {
  if (_documentValidator) return _documentValidator;
  _documentValidator = wrapNode(
    compileSchema(obiSchema, { drafts: [OBI_BOUNDARY_DRAFT] }),
  );
  return _documentValidator;
}

let _metaValidator: CompiledSchema | null = null;

/**
 * The vendored JSON Schema 2020-12 meta-schema, compiled as a compound
 * document (vocabulary meta-schemas embedded under $defs; their absolute
 * $ids resolve the root's allOf refs). Used to refuse malformed schemas
 * at compile time — a draft-4-form `exclusiveMinimum: true` or an
 * array-form `items` is rejected rather than silently misread, matching
 * the Go backend's compile-time meta-validation.
 */
function metaValidator(): CompiledSchema {
  if (_metaValidator) return _metaValidator;
  const vocabs = [
    metaCore,
    metaApplicator,
    metaValidation,
    metaMetaData,
    metaFormatAnnotation,
    metaContent,
    metaUnevaluated,
  ];
  const compound: Record<string, unknown> = {
    ...(metaSchema as Record<string, unknown>),
    $defs: Object.fromEntries(vocabs.map((v, i) => [`vocab${i}`, v])),
  };
  // The meta-schema's own $schema is itself; drop it to avoid a
  // self-referential dialect lookup during compilation.
  delete compound.$schema;
  _metaValidator = wrapNode(compileSchema(compound, { drafts: [OBI_BOUNDARY_DRAFT] }));
  return _metaValidator;
}

/**
 * Reports OBI-D-02 violations: the document does not validate against
 * openbindings.schema.json. Errors are appended to errs.
 *
 * If the validator throws (e.g., on `undefined` values inside the
 * document — JS-only state that JSON has no representation for), the
 * exception is captured as a single OBI-D-02 problem so the rule
 * walker's accumulated errors are still surfaced.
 */
export function validateAgainstOBISchema(
  errs: string[],
  iface: unknown,
): void {
  let result;
  try {
    result = documentValidator().validate(iface);
  } catch (err) {
    errs.push(
      `schema validation: ${(err as Error).message ?? "validator error"} (OBI-D-02)`,
    );
    return;
  }
  if (result.valid) return;
  for (const f of result.failures) {
    const msg = `${f.path ? f.path + ": " : ""}${f.message}`;
    errs.push(`schema validation: ${msg} (OBI-D-02)`);
  }
}

/**
 * Reports OBI-D-11 violations: every example.input/output that has its
 * operation's input/output schema specified must validate against that
 * schema. An explicit `null` is a provided example value, distinct from an
 * absent field, and is validated.
 *
 * Verification is capability-relative (cf. the spec's §8 / OBI-D-13
 * discussion): when a schema's $refs point outside the document, this
 * validator cannot resolve them and abstains from example validation for
 * that operation rather than failing the document.
 */
export function validateExamplesAgainstOpSchemas(
  errs: string[],
  iface: OBInterface,
): void {
  const opEntries = Object.entries(iface.operations ?? {});
  if (opEntries.length === 0) return;
  const defs = buildSchemaDefs(iface.schemas);
  // If any document schema carries an external $ref, the compound schema
  // space is not fully resolvable locally; abstain across the board.
  const defsExternal = schemaHasExternalRef(defs);
  for (const [opKey, op] of opEntries) {
    if (!op.examples) continue;

    let inputValidator: CompiledSchema | undefined;
    let outputValidator: CompiledSchema | undefined;
    if (op.input != null && !defsExternal && !schemaHasExternalRef(op.input)) {
      try {
        inputValidator = compileExampleSchema(op.input, defs);
      } catch (err) {
        errs.push(
          `operations["${opKey}"].input: cannot compile schema: ${(err as Error).message} (OBI-D-11)`,
        );
      }
    }
    if (op.output != null && !defsExternal && !schemaHasExternalRef(op.output)) {
      try {
        outputValidator = compileExampleSchema(op.output, defs);
      } catch (err) {
        errs.push(
          `operations["${opKey}"].output: cannot compile schema: ${(err as Error).message} (OBI-D-11)`,
        );
      }
    }
    for (const [exKey, ex] of Object.entries(op.examples)) {
      if (ex.input !== undefined && inputValidator) {
        const r = safeValidate(inputValidator, ex.input);
        if (!r.valid) {
          for (const e of r.errors) {
            errs.push(
              `operations["${opKey}"].examples["${exKey}"].input: ${e} (OBI-D-11)`,
            );
          }
        }
      }
      if (ex.output !== undefined && outputValidator) {
        const r = safeValidate(outputValidator, ex.output);
        if (!r.valid) {
          for (const e of r.errors) {
            errs.push(
              `operations["${opKey}"].examples["${exKey}"].output: ${e} (OBI-D-11)`,
            );
          }
        }
      }
    }
  }
}

/**
 * Returns true when any `$ref` in the schema tree points outside the
 * document (i.e., does not start with `#`). Such references are
 * unresolvable without fetching external resources, so document validation
 * abstains from example checks against them. (An absolute $ref matching an
 * embedded $id would resolve locally per §10; abstaining on it here is
 * conservative partial verification, which the spec's §10.2 posture
 * permits — unverified, not non-conformant.)
 */
function schemaHasExternalRef(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(schemaHasExternalRef);
  }
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.$ref === "string" && !obj.$ref.startsWith("#")) {
    return true;
  }
  return Object.values(obj).some(schemaHasExternalRef);
}

/**
 * Compiles a single operation schema with the document's schemas
 * exposed under $defs (so `$ref: "#/schemas/X"` references resolve).
 * Used by validateExamplesAgainstOpSchemas (OBI-D-11) and by
 * OperationInvoker (OBI-T-16).
 *
 * Enforcement at compile time, per the spec's boundary rules:
 * - the schema must conform to JSON Schema 2020-12 (meta-validation; a
 *   draft-4-form keyword is refused, never silently misread), and
 * - the schema must be fully resolvable, judged STATICALLY over the
 *   whole governing schema (T-07/T-08): an unresolvable `$ref` anywhere
 *   throws here, before any value is validated. "External" means not
 *   resolvable within the document — an absolute `$ref` matching an
 *   embedded schema's `$id` resolves locally (§10).
 */
export function compileExampleSchema(
  schema: unknown,
  defs: Record<string, unknown> | undefined,
): CompiledSchema {
  const root = buildCompoundSchema(schema, defs);
  if (typeof root === "object" && root !== null) {
    const meta = metaValidator().validate(root);
    if (!meta.valid) {
      // An invalid result normally carries at least one failure; if the
      // backend ever reports invalid without details, fall back to the
      // same generic diagnostic wrapNode uses.
      const first = meta.failures[0] ?? { path: "", message: "schema violation" };
      throw new Error(
        `schema does not conform to JSON Schema 2020-12: ${first.path ? first.path + ": " : ""}${first.message}`,
      );
    }
    assertFullyResolvable(root as Record<string, unknown>);
  }
  return wrapNode(compileSchema(root as object, { drafts: [OBI_BOUNDARY_DRAFT] }));
}

/**
 * Compiles a self-contained embedded schema (no $refs, by rule — e.g.
 * the operation-graph engine's filter/buffer schemas, whose form
 * OG-V-18 already validates). Skips document-compound handling and
 * meta-validation; the boundary draft still applies, so `format` never
 * asserts.
 */
export function compileEmbeddedSchema(schema: unknown): CompiledSchema {
  return wrapNode(compileSchema(schema as object, { drafts: [OBI_BOUNDARY_DRAFT] }));
}

// ---------------------------------------------------------------------------
// Static resolvability (T-07/T-08's fully-resolved requirement)
// ---------------------------------------------------------------------------

const SCHEMA_MAP_KEYWORDS = new Set([
  "properties", "patternProperties", "$defs", "definitions", "dependentSchemas",
]);
const SCHEMA_SINGLE_KEYWORDS = new Set([
  "items", "additionalItems", "unevaluatedItems", "contains",
  "additionalProperties", "unevaluatedProperties", "propertyNames", "not",
  "if", "then", "else", "contentSchema",
]);
const SCHEMA_ARRAY_KEYWORDS = new Set(["prefixItems", "allOf", "anyOf", "oneOf"]);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Walks the governing schema's static closure (keyword-shape-aware) and
 * throws on the first `$ref` that cannot resolve within the document:
 * same-document pointers must point at an existing location; absolute
 * URIs must match an embedded schema's `$id` (with any fragment
 * resolving inside that resource). Fail-closed: an exotic reference
 * this walk cannot prove resolvable is refused with the ref named,
 * never validated partially.
 *
 * The closure is REACHABILITY-scoped, mirroring the Go SDK's compiler:
 * T-07/T-08's "whole governing schema" is everything evaluation can
 * statically reach from the governing root — its keyword subschemas
 * plus every reference target, transitively (an unresolvable anyOf
 * branch still fails even when a value would not reach it). A schema
 * that is lexically present but unreachable (an unreferenced `$defs`
 * entry, an unrelated document-schemas entry merged into the compound)
 * never participates in any verdict and must not poison the boundary;
 * a dangling same-document ref there is OBI-D-16's document-level
 * concern, not an invocation refusal.
 */
function assertFullyResolvable(root: Record<string, unknown>): void {
  // Pass 1 (lexical): collect embedded $id resources across the whole
  // compound — identity resolution is in-document wherever the resource
  // sits (§10), even inside an entry nothing references directly.
  const idResources = new Map<string, Record<string, unknown>>();
  (function collectIds(node: unknown): void {
    if (!isObj(node)) return;
    if (typeof node.$id === "string") idResources.set(node.$id.replace(/#$/, ""), node);
    walkSchemaChildren(node, collectIds);
  })(root);

  // Pass 2 (reachable): follow keyword subschemas and $ref targets from
  // the governing root only.
  const visited = new Set<unknown>();
  (function visit(node: unknown, scope: Record<string, unknown>, base: string): void {
    if (!isObj(node) || visited.has(node)) return;
    visited.add(node);
    let currentScope = scope;
    let currentBase = base;
    if (typeof node.$id === "string") {
      currentScope = node;
      currentBase = node.$id;
    }
    if (typeof node.$ref === "string") {
      const target = resolveRefTarget(node.$ref, currentScope, currentBase, idResources);
      visit(target.node, target.scope, target.base);
    }
    walkReachableChildren(node, (child) => visit(child, currentScope, currentBase));
  })(root, root, "");
}

function walkSchemaChildren(node: Record<string, unknown>, visit: (child: unknown) => void): void {
  for (const [k, v] of Object.entries(node)) {
    if (SCHEMA_MAP_KEYWORDS.has(k) && isObj(v)) {
      for (const mv of Object.values(v)) visit(mv);
    } else if (SCHEMA_SINGLE_KEYWORDS.has(k) && isObj(v)) {
      visit(v);
    } else if (SCHEMA_ARRAY_KEYWORDS.has(k) && Array.isArray(v)) {
      for (const item of v) visit(item);
    }
  }
}

// walkReachableChildren visits the keyword subschemas evaluation can reach
// from a schema node. Identical to walkSchemaChildren except that `$defs`
// and `definitions` entries are NOT visited structurally: they become
// reachable only through a $ref that targets them.
const REACHABLE_MAP_KEYWORDS = new Set(["properties", "patternProperties", "dependentSchemas"]);
function walkReachableChildren(node: Record<string, unknown>, visit: (child: unknown) => void): void {
  for (const [k, v] of Object.entries(node)) {
    if (REACHABLE_MAP_KEYWORDS.has(k) && isObj(v)) {
      for (const mv of Object.values(v)) visit(mv);
    } else if (SCHEMA_SINGLE_KEYWORDS.has(k) && isObj(v)) {
      visit(v);
    } else if (SCHEMA_ARRAY_KEYWORDS.has(k) && Array.isArray(v)) {
      for (const item of v) visit(item);
    }
  }
}

interface RefTarget {
  node: unknown;
  scope: Record<string, unknown>;
  base: string;
}

function resolveRefTarget(
  ref: string,
  scope: Record<string, unknown>,
  base: string,
  idResources: Map<string, Record<string, unknown>>,
): RefTarget {
  const fail = (): never => {
    throw new Error(`unresolvable $ref ${JSON.stringify(ref)} (fully-resolved validation, OBI-T-16; external schemas are not fetched)`);
  };
  if (ref.startsWith("#")) {
    const fragment = ref.slice(1);
    // Inside an $id resource, fragments resolve within that resource;
    // at root scope, within the compound root.
    const target = resolveFragment(fragment, scope, base);
    if (target === NOT_FOUND) return fail();
    return target;
  }
  // Absolute or relative URI: resolve against the scope's base, then
  // match an embedded $id resource.
  let uri: string;
  try {
    uri = base ? new URL(ref, base).toString() : new URL(ref).toString();
  } catch {
    return fail();
  }
  // split() always yields at least one element, so resourceUri's default
  // never fires; it exists to type the destructured element as present.
  const [resourceUri = "", fragment = ""] = uri.split("#", 2);
  const resource = idResources.get(resourceUri);
  if (!resource) return fail();
  const target = resolveFragment(fragment, resource, resourceUri);
  if (target === NOT_FOUND) return fail();
  return target;
}

/** Sentinel distinguishing "fragment did not resolve" from a resolved undefined/null value. */
const NOT_FOUND = Symbol("not-found");

/**
 * Resolves a fragment ("" root, "/a/b" pointer, "name" anchor) within a
 * schema tree, returning the target with its resolution scope (a pointer
 * that lands in — or passes through — a nested $id resource adopts that
 * resource as the scope its internal refs resolve against), or NOT_FOUND.
 */
function resolveFragment(
  fragment: string,
  scope: Record<string, unknown>,
  base: string,
): RefTarget | typeof NOT_FOUND {
  // The fragment is the pointer's URI-fragment representation (RFC 6901
  // §6): percent-decode the whole fragment first, then evaluate the
  // result as a JSON Pointer (§10). Malformed percent-encoding simply
  // fails to resolve — it is already a D-05 char-screen violation upstream.
  try {
    fragment = decodeURIComponent(fragment);
  } catch {
    return NOT_FOUND;
  }
  if (fragment === "") return { node: scope, scope, base };
  if (fragment.startsWith("/")) {
    let cur: unknown = scope;
    let curScope = scope;
    let curBase = base;
    for (const raw of fragment.slice(1).split("/")) {
      const tok = raw.replaceAll("~1", "/").replaceAll("~0", "~");
      if (Array.isArray(cur)) {
        const idx = /^\d+$/.test(tok) ? Number(tok) : -1;
        if (idx < 0 || idx >= cur.length) return NOT_FOUND;
        cur = cur[idx];
      } else if (isObj(cur)) {
        if (!(Object.prototype.hasOwnProperty.call(cur, tok))) return NOT_FOUND;
        cur = cur[tok];
      } else {
        return NOT_FOUND;
      }
      if (isObj(cur) && typeof cur.$id === "string") {
        curScope = cur;
        curBase = cur.$id;
      }
    }
    return { node: cur, scope: curScope, base: curBase };
  }
  // Plain-name anchor: search $anchor within the scope, not crossing
  // into nested $id resources (which are their own anchor scopes).
  let found: unknown = NOT_FOUND;
  (function search(node: unknown, isRoot: boolean): void {
    if (found !== NOT_FOUND || !isObj(node)) return;
    if (!isRoot && typeof node.$id === "string") return;
    if (node.$anchor === fragment) {
      found = node;
      return;
    }
    walkSchemaChildren(node, (child) => search(child, false));
  })(scope, true);
  if (found === NOT_FOUND) return NOT_FOUND;
  return { node: found, scope, base };
}

/**
 * A single validation failure surfaced in a stable, validator-agnostic
 * shape. Multiple failures can come from a single validate() call when
 * the schema has multiple constraints violated by the value.
 *
 * The fields are translated from the underlying validator's vocabulary
 * so SDK consumers don't depend on the backend directly.
 */
export interface ValidationFailure {
  /**
   * Instance location as a JSON Pointer ("" for the root, "/a/b" for
   * members) — the same dialect the Go SDK reports.
   */
  path: string;
  /** Human-readable diagnostic. */
  message: string;
  /** Optional JSON Pointer into the schema. */
  schemaPath?: string;
}

/**
 * Wraps CompiledSchema.validate to catch any thrown errors (the
 * underlying validator may throw on inputs JSON cannot represent, e.g.
 * `undefined`). Callers see an SDK-defined error contract rather than
 * the underlying validator's API.
 */
export function safeValidate(
  validator: CompiledSchema,
  value: unknown,
): { valid: true } | { valid: false; errors: string[]; failures: ValidationFailure[] } {
  let result;
  try {
    result = validator.validate(value);
  } catch (err) {
    const message = (err as Error).message ?? "validator error";
    return {
      valid: false,
      errors: [message],
      failures: [{ path: "", message }],
    };
  }
  if (result.valid) return { valid: true };
  const failures = result.failures;
  const errors = failures.map((f) => (f.path ? `${f.path}: ${f.message}` : f.message));
  return { valid: false, errors, failures };
}

/**
 * Builds the document's `schemas` map ready to be embedded under
 * `$defs`, with internal `#/schemas/` refs rewritten to `#/$defs/`.
 */
export function buildSchemaDefs(
  schemas: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!schemas || Object.keys(schemas).length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const [name, sch] of Object.entries(schemas)) {
    const copy = structuredClone(sch);
    if (typeof copy === "object" && copy !== null) {
      rewriteSchemaRefs(copy);
    }
    out[name] = copy;
  }
  return out;
}

function buildCompoundSchema(
  schema: unknown,
  defs: Record<string, unknown> | undefined,
): unknown {
  const root = structuredClone(schema);
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    return root;
  }
  const obj = root as Record<string, unknown>;
  rewriteSchemaRefs(obj);
  if (defs && Object.keys(defs).length > 0) {
    const existing = obj.$defs;
    if (
      typeof existing === "object" &&
      existing !== null &&
      !Array.isArray(existing)
    ) {
      const merged = existing as Record<string, unknown>;
      for (const [k, v] of Object.entries(defs)) {
        if (!Object.hasOwn(merged, k)) merged[k] = v;
      }
    } else {
      obj.$defs = defs;
    }
  }
  return obj;
}

function rewriteSchemaRefs(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) rewriteSchemaRefs(child);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const obj = value as Record<string, unknown>;
  const ref = obj.$ref;
  if (typeof ref === "string" && ref.startsWith("#/schemas/")) {
    obj.$ref = "#/$defs/" + ref.slice("#/schemas/".length);
  }
  for (const child of Object.values(obj)) rewriteSchemaRefs(child);
}

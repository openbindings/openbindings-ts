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
import { isValidSemver } from "./version.js";
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

type JslError = {
  code?: unknown;
  message?: string;
  data?: { pointer?: string; schema?: unknown };
};

const VALIDATION_KEYWORD_BY_CODE: Readonly<Record<string, string>> = Object.freeze({
  "additional-items-error": "items",
  "additional-properties-error": "additionalProperties",
  "all-of-error": "allOf",
  "any-of-error": "anyOf",
  "const-error": "const",
  "contains-any-error": "contains",
  "contains-array-error": "contains",
  "contains-error": "contains",
  "contains-min-error": "minContains",
  "contains-max-error": "maxContains",
  "enum-error": "enum",
  "exclusive-maximum-error": "exclusiveMaximum",
  "exclusive-minimum-error": "exclusiveMinimum",
  "forbidden-property-error": "properties",
  "maximum-error": "maximum",
  "max-items-error": "maxItems",
  "max-length-error": "maxLength",
  "max-properties-error": "maxProperties",
  "minimum-error": "minimum",
  "min-items-error": "minItems",
  "min-items-one-error": "minItems",
  "min-length-error": "minLength",
  "min-length-one-error": "minLength",
  "min-properties-error": "minProperties",
  "missing-array-item-error": "prefixItems",
  "missing-dependency-error": "dependentRequired",
  "multiple-of-error": "multipleOf",
  "no-additional-properties-error": "additionalProperties",
  "not-error": "not",
  "one-of-error": "oneOf",
  "pattern-error": "pattern",
  "pattern-properties-error": "patternProperties",
  "ref-error": "$ref",
  "required-property-error": "required",
  "type-error": "type",
  "unevaluated-property-error": "unevaluatedProperties",
  "unevaluated-items-error": "unevaluatedItems",
  "unique-items-error": "uniqueItems",
});

function validationSchemaPaths(node: ReturnType<typeof compileSchema>): WeakMap<object, string> {
  const paths = new WeakMap<object, string>();
  const pending: Array<{ value: unknown; pointer: string }> = [{ value: node.schema, pointer: "" }];
  while (pending.length > 0) {
    const { value, pointer } = pending.pop()!;
    if (typeof value !== "object" || value === null || paths.has(value)) continue;
    paths.set(value, pointer);
    for (const [key, child] of Object.entries(value)) {
      pending.push({ value: child, pointer: `${pointer}/${escapePointerToken(key)}` });
    }
  }
  return paths;
}

function validationSchemaPath(error: JslError, paths: WeakMap<object, string>): string | undefined {
  const schema = error.data?.schema;
  if (typeof schema !== "object" || schema === null) return undefined;
  const base = paths.get(schema);
  if (base === undefined) return undefined;
  const keyword = typeof error.code === "string" ? VALIDATION_KEYWORD_BY_CODE[error.code] : undefined;
  return keyword
    ? `${base}/${keyword.replaceAll("~", "~0").replaceAll("/", "~1")}`
    : undefined;
}

function wrapNode(node: ReturnType<typeof compileSchema>): CompiledSchema {
  const schemaPaths = validationSchemaPaths(node);
  return {
    validate(value: unknown) {
      const r = node.validate(value);
      if (r.valid) return { valid: true, failures: [] };
      const failures: ValidationFailure[] = (r.errors ?? []).map((e: JslError) => {
        const schemaPath = validationSchemaPath(e, schemaPaths);
        return {
          path: normalizePointer(e.data?.pointer),
          message: e.message ?? "schema violation",
          ...(schemaPath ? { schemaPath } : {}),
        };
      });
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
    // Fast path first (see metaValidatesNodeWise): a synthesized boundary
    // schema is a DAG whose shared component subtrees repeat thousands of
    // times, and the backend re-walks every repetition. When the node-wise
    // check proves well-formedness, the whole-tree walk is skipped; when it
    // cannot, the whole-tree walk below remains the sole authority on which
    // failures are reported.
    if (metaValidatesNodeWise(schema as Record<string, unknown>)) return;
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

// ---------------------------------------------------------------------------
// Node-wise well-formedness (an acceleration of the whole-tree meta-check)
// ---------------------------------------------------------------------------

/**
 * The 2020-12 meta-schema positions whose value is a `{ name -> schema }`
 * map, an array of schemas, or a single schema. Every one of them constrains
 * its subschemas solely by recursing the meta-schema into them
 * (`$dynamicRef: "#meta"`), which is what makes the node-wise decomposition
 * below exact.
 *
 * `dependencies` is deliberately absent: its members are a CHOICE between a
 * schema and a string array, so a member's verdict is not the meta-schema's
 * verdict on a schema. Leaving a position out only costs speed — the value
 * stays in place and the meta-schema checks it where it sits.
 */
const META_SUBSCHEMA_MAP_KEYWORDS = new Set([
  "properties", "patternProperties", "dependentSchemas", "$defs", "definitions",
]);
const META_SUBSCHEMA_ARRAY_KEYWORDS = new Set([
  "allOf", "anyOf", "oneOf", "prefixItems",
]);
const META_SUBSCHEMA_SINGLE_KEYWORDS = new Set([
  "items", "contains", "additionalProperties", "propertyNames", "not",
  "if", "then", "else", "unevaluatedItems", "unevaluatedProperties",
  "contentSchema",
]);

/**
 * Distinct node SHAPES already meta-validated, keyed by the JSON text of the
 * shape. Synthesized boundary schemas repeat the same component shapes across
 * every operation that mentions them, so this is where the dominant saving
 * comes from. Keyed by value, never by object identity: a caller that mutates
 * a schema between validations still gets the mutated shape's own verdict.
 */
const nodeShapeVerdicts = new Map<string, boolean>();
const NODE_SHAPE_VERDICT_LIMIT = 20000;

/** An object-form schema: the only value this decomposition lifts out. */
function isObjectFormSchema(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Object or boolean form — the two forms a schema position admits. */
function isSchemaPositionValue(value: unknown): boolean {
  return typeof value === "boolean" || isObjectFormSchema(value);
}

/**
 * Builds one node's SHAPE: the node with every object-form subschema replaced
 * by `true`. `true` is well-formed under every vocabulary, so the shape's
 * verdict is exactly the node's own contribution; the replaced subschemas are
 * collected into `children` and checked on their own. Values that are not in
 * schema form stay exactly where they are, so a malformed `items: [ ... ]` or
 * `properties: 3` still fails at the node that declares it.
 */
function nodeShape(
  node: Record<string, unknown>,
  children: Record<string, unknown>[],
): Record<string, unknown> {
  const shape: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(node)) {
    if (META_SUBSCHEMA_MAP_KEYWORDS.has(keyword) && isObjectFormSchema(value)) {
      const members: Record<string, unknown> = {};
      for (const [name, member] of Object.entries(value)) {
        if (!isSchemaPositionValue(member)) { members[name] = member; continue; }
        if (isObjectFormSchema(member)) children.push(member);
        members[name] = true;
      }
      shape[keyword] = members;
    } else if (META_SUBSCHEMA_ARRAY_KEYWORDS.has(keyword) && Array.isArray(value)) {
      shape[keyword] = (value as unknown[]).map((member): unknown => {
        if (!isSchemaPositionValue(member)) return member;
        if (isObjectFormSchema(member)) children.push(member);
        return true;
      });
    } else if (META_SUBSCHEMA_SINGLE_KEYWORDS.has(keyword) && isSchemaPositionValue(value)) {
      if (isObjectFormSchema(value)) children.push(value);
      shape[keyword] = true;
    } else {
      shape[keyword] = value;
    }
  }
  return shape;
}

/**
 * Proves OBI-D-17 well-formedness node by node instead of by whole tree.
 *
 * A JSON Schema is well-formed exactly when every schema-position node in it
 * is: the 2020-12 meta-schema constrains a node's own keywords and otherwise
 * only recurses itself into that node's subschemas. Deciding it node-wise
 * therefore reaches the same verdict while visiting each DISTINCT node once
 * — a synthesized boundary schema is a DAG in which one dereferenced
 * component subtree occurs at hundreds of positions, and the whole-tree walk
 * re-validates every occurrence.
 *
 * Returns true only when every reachable node's shape validated. `false`
 * means "not proven here" — never "invalid": the caller re-runs the
 * whole-tree meta-validation, which stays the sole authority on the reported
 * failures. Anything this decomposition does not model (a position kept out
 * of the keyword sets, a value form it does not recognize) is left in place
 * and decided by the meta-schema, so the answer can only be conservative.
 */
function metaValidatesNodeWise(root: Record<string, unknown>): boolean {
  const visited = new WeakSet<object>();
  const pending: Record<string, unknown>[] = [root];
  while (pending.length > 0) {
    const node = pending.pop() as Record<string, unknown>;
    if (visited.has(node)) continue;
    visited.add(node);

    const children: Record<string, unknown>[] = [];
    const shape = nodeShape(node, children);

    let key: string | undefined;
    try {
      key = JSON.stringify(shape);
    } catch {
      // A value JSON cannot represent (a cycle through an annotation, a
      // BigInt) has no shape key; decide this node without the cache.
      key = undefined;
    }
    let verdict = key === undefined ? undefined : nodeShapeVerdicts.get(key);
    if (verdict === undefined) {
      verdict = metaValidator().validate(shape).valid;
      if (key !== undefined) {
        if (nodeShapeVerdicts.size >= NODE_SHAPE_VERDICT_LIMIT) nodeShapeVerdicts.clear();
        nodeShapeVerdicts.set(key, verdict);
      }
    }
    if (!verdict) return false;

    for (const child of children) pending.push(child);
  }
  return true;
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
  validateOBIStructure(errs, iface);
}

/**
 * Single-pass evaluator for openbindings.schema.json.
 *
 * The OBI schema is intentionally a shallow typed-document schema; recursive
 * JSON Schema correctness is the separate OBI-D-17 meta-schema walk below.
 * Evaluating its fixed constraints directly avoids a generic validator
 * recompiling the same Operation/Dependency/Binding subschema thousands of
 * times while preserving the exact acceptance language. Keep this function
 * synchronized with openbindings.schema.json; the constraint matrix tests
 * cover every property in the derived schema.
 */
function validateOBIStructure(errs: string[], value: unknown): void {
  const problem = (path: string, message: string): void => {
    errs.push(`schema validation: ${path ? path + ": " : ""}${message} (OBI-D-02)`);
  };
  const object = plainJSONObject(value);
  if (!object) {
    problem("", "must be object");
    return;
  }

  requiredString(object, "openbindings", "/openbindings", problem, isValidSemver);
  optionalString(object, "name", "/name", problem);
  optionalString(object, "version", "/version", problem, string => string.length > 0);
  optionalString(object, "description", "/description", problem);

  const schemas = optionalMap(object, "schemas", "/schemas", problem);
  if (schemas) {
    for (const [key, schema] of Object.entries(schemas)) {
      if (!OBI_IDENTIFIER.test(key)) problem(`/schemas/${pointerToken(key)}`, "property name does not match identifier pattern");
      validateJSONSchemaMember(schema, `/schemas/${pointerToken(key)}`, problem);
    }
  }

  const operations = requiredMap(object, "operations", "/operations", problem);
  if (operations) {
    for (const [key, operation] of Object.entries(operations)) {
      const path = `/operations/${pointerToken(key)}`;
      if (!OBI_IDENTIFIER.test(key)) problem(path, "property name does not match identifier pattern");
      validateOperationShape(operation, path, problem);
    }
  }

  const dependencies = optionalMap(object, "dependencies", "/dependencies", problem);
  if (dependencies) {
    for (const [key, dependency] of Object.entries(dependencies)) {
      const path = `/dependencies/${pointerToken(key)}`;
      if (!OBI_IDENTIFIER.test(key)) problem(path, "property name does not match identifier pattern");
      validateDependencyShape(dependency, path, problem);
    }
  }

  const sources = optionalMap(object, "sources", "/sources", problem);
  if (sources) {
    for (const [key, source] of Object.entries(sources)) {
      const path = `/sources/${pointerToken(key)}`;
      if (!OBI_IDENTIFIER.test(key)) problem(path, "property name does not match identifier pattern");
      validateSourceShape(source, path, problem);
    }
  }

  const bindings = optionalMap(object, "bindings", "/bindings", problem);
  if (bindings) {
    for (const [key, binding] of Object.entries(bindings)) {
      const path = `/bindings/${pointerToken(key)}`;
      if (!OBI_IDENTIFIER.test(key)) problem(path, "property name does not match identifier pattern");
      validateBindingShape(binding, path, problem);
    }
  }

  const transforms = optionalMap(object, "transforms", "/transforms", problem);
  if (transforms) {
    for (const [key, transform] of Object.entries(transforms)) {
      const path = `/transforms/${pointerToken(key)}`;
      if (!OBI_IDENTIFIER.test(key)) problem(path, "property name does not match identifier pattern");
      if (typeof transform !== "string") problem(path, "must be string");
    }
  }
}

type StructuralProblem = (path: string, message: string) => void;

const OBI_IDENTIFIER = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

function plainJSONObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * json-schema-library treats an own property whose JavaScript value is
 * `undefined` as absent. Synthesizers commonly construct typed objects with
 * optional fields present as `undefined`, so the specialized evaluator must
 * preserve that established boundary behavior even though `undefined` is not
 * itself a JSON value.
 */
function present(object: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(object, key) && object[key] !== undefined;
}

function requiredString(
  object: Record<string, unknown>,
  key: string,
  path: string,
  problem: StructuralProblem,
  predicate?: (value: string) => boolean,
): void {
  if (!present(object, key)) {
    problem(path, "is required");
    return;
  }
  const value = object[key];
  if (typeof value !== "string") problem(path, "must be string");
  else if (predicate && !predicate(value)) problem(path, "does not satisfy its schema constraint");
}

function optionalString(
  object: Record<string, unknown>,
  key: string,
  path: string,
  problem: StructuralProblem,
  predicate?: (value: string) => boolean,
): void {
  if (!present(object, key)) return;
  const value = object[key];
  if (typeof value !== "string") problem(path, "must be string");
  else if (predicate && !predicate(value)) problem(path, "does not satisfy its schema constraint");
}

function requiredMap(
  object: Record<string, unknown>,
  key: string,
  path: string,
  problem: StructuralProblem,
): Record<string, unknown> | undefined {
  if (!present(object, key)) {
    problem(path, "is required");
    return undefined;
  }
  const map = plainJSONObject(object[key]);
  if (!map) problem(path, "must be object");
  return map;
}

function optionalMap(
  object: Record<string, unknown>,
  key: string,
  path: string,
  problem: StructuralProblem,
): Record<string, unknown> | undefined {
  if (!present(object, key)) return undefined;
  const map = plainJSONObject(object[key]);
  if (!map) problem(path, "must be object");
  return map;
}

function optionalTyped(
  object: Record<string, unknown>,
  key: string,
  path: string,
  expected: "string" | "boolean",
  problem: StructuralProblem,
): void {
  if (present(object, key) && typeof object[key] !== expected) {
    problem(path, `must be ${expected}`);
  }
}

function validateJSONSchemaMember(
  schema: unknown,
  path: string,
  problem: StructuralProblem,
): void {
  if (typeof schema === "boolean") return;
  const object = plainJSONObject(schema);
  if (!object) {
    problem(path, "must be a JSON Schema object or boolean");
    return;
  }
  if (present(object, "$schema") && object.$schema !== "https://json-schema.org/draft/2020-12/schema") {
    problem(`${path}/$schema`, "must equal the JSON Schema 2020-12 dialect URI");
  }
  if (present(object, "$vocabulary")) {
    problem(`${path}/$vocabulary`, "is forbidden");
  }
}

function validateOperationShape(
  value: unknown,
  path: string,
  problem: StructuralProblem,
): void {
  const operation = plainJSONObject(value);
  if (!operation) {
    problem(path, "must be object");
    return;
  }
  optionalTyped(operation, "description", `${path}/description`, "string", problem);
  optionalTyped(operation, "deprecated", `${path}/deprecated`, "boolean", problem);
  optionalTyped(operation, "idempotent", `${path}/idempotent`, "boolean", problem);
  if (present(operation, "tags")) {
    validateStringArray(operation.tags, `${path}/tags`, problem, false, false);
  }
  if (present(operation, "aliases")) {
    validateStringArray(operation.aliases, `${path}/aliases`, problem, true, true);
  }
  for (const member of ["input", "output"] as const) {
    if (present(operation, member)) {
      validateJSONSchemaMember(operation[member], `${path}/${member}`, problem);
    }
  }
  const examples = optionalMap(operation, "examples", `${path}/examples`, problem);
  if (examples) {
    for (const [key, value] of Object.entries(examples)) {
      const examplePath = `${path}/examples/${pointerToken(key)}`;
      if (!OBI_IDENTIFIER.test(key)) problem(examplePath, "property name does not match identifier pattern");
      const example = plainJSONObject(value);
      if (!example) problem(examplePath, "must be object");
      else optionalTyped(example, "description", `${examplePath}/description`, "string", problem);
    }
  }
}

function validateStringArray(
  value: unknown,
  path: string,
  problem: StructuralProblem,
  unique: boolean,
  identifiers: boolean,
): void {
  if (!Array.isArray(value)) {
    problem(path, "must be array");
    return;
  }
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    if (!(index in value) || typeof value[index] !== "string") {
      problem(`${path}/${index}`, "must be string");
      continue;
    }
    const member = value[index] as string;
    if (identifiers && !OBI_IDENTIFIER.test(member)) problem(`${path}/${index}`, "does not match identifier pattern");
    if (unique && seen.has(member)) problem(path, "must contain unique items");
    seen.add(member);
  }
}

function validateDependencyShape(
  value: unknown,
  path: string,
  problem: StructuralProblem,
): void {
  const dependency = plainJSONObject(value);
  if (!dependency) {
    problem(path, "must be object");
    return;
  }
  requiredString(dependency, "operation", `${path}/operation`, problem, value => OBI_IDENTIFIER.test(value));
  if (present(dependency, "bindingSpecs")) {
    const specs = dependency.bindingSpecs;
    if (!Array.isArray(specs)) {
      problem(`${path}/bindingSpecs`, "must be array");
    } else {
      const values = specs as unknown[];
      if (values.length < 1) problem(`${path}/bindingSpecs`, "must contain at least one item");
      const seen = new Set<string>();
      for (let index = 0; index < values.length; index++) {
        const spec = values[index];
        if (typeof spec !== "string" || spec.length === 0) {
          problem(`${path}/bindingSpecs/${index}`, "must be a non-empty string");
        } else if (seen.has(spec)) {
          problem(`${path}/bindingSpecs`, "must contain unique items");
        }
        if (typeof spec === "string") seen.add(spec);
      }
    }
  }
}

function validateSourceShape(
  value: unknown,
  path: string,
  problem: StructuralProblem,
): void {
  const source = plainJSONObject(value);
  if (!source) {
    problem(path, "must be object");
    return;
  }
  requiredString(source, "bindingSpec", `${path}/bindingSpec`, problem, value => value.length > 0);
  optionalString(source, "location", `${path}/location`, problem, value => value.length > 0);
  optionalTyped(source, "description", `${path}/description`, "string", problem);
  if (!present(source, "location") && !present(source, "content")) {
    problem(path, "must contain location or content");
  }
}

function validateBindingShape(
  value: unknown,
  path: string,
  problem: StructuralProblem,
): void {
  const binding = plainJSONObject(value);
  if (!binding) {
    problem(path, "must be object");
    return;
  }
  requiredString(binding, "operation", `${path}/operation`, problem, value => OBI_IDENTIFIER.test(value));
  requiredString(binding, "source", `${path}/source`, problem, value => OBI_IDENTIFIER.test(value));
  optionalTyped(binding, "selector", `${path}/selector`, "string", problem);
  optionalTyped(binding, "description", `${path}/description`, "string", problem);
  optionalTyped(binding, "deprecated", `${path}/deprecated`, "boolean", problem);
  if (present(binding, "preference")) {
    const preference = binding.preference;
    if (typeof preference !== "number" || !Number.isSafeInteger(preference)) {
      problem(`${path}/preference`, "must be a safe integer");
    }
  }
  for (const member of ["inputTransform", "outputTransform"] as const) {
    if (!present(binding, member)) continue;
    const transform = binding[member];
    if (typeof transform === "string") continue;
    const reference = plainJSONObject(transform);
    if (
      !reference ||
      typeof reference.$ref !== "string" ||
      !/^#\/transforms\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(reference.$ref)
    ) {
      problem(`${path}/${member}`, "must be a transform string or valid transform reference");
    }
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
        inputValidator = compileOperationSchema(iface, opKey, "input");
      } catch (err) {
        errs.push(
          `operations["${opKey}"].input: cannot compile schema: ${(err as Error).message} (OBI-D-11)`,
        );
      }
    }
    if (op.output != null && !defsExternal && !schemaHasExternalRef(op.output)) {
      try {
        outputValidator = compileOperationSchema(iface, opKey, "output");
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
 * Compiled-schema cache, keyed on the identity of the schema and its defs.
 *
 * Compilation meta-validates, checks static resolvability, and builds a
 * validator over the whole reachable schema graph. Invokers compile once per
 * invocation, so for a document with a large schema graph every call — and
 * every advisory preflight — paid that cost again for an identical input.
 * Same immutability assumption as `buildSchemaDefs`.
 */
const NO_DEFS: Record<string, unknown> = {};
const compiledSchemaCache = new WeakMap<
  object,
  WeakMap<object, CompiledSchema>
>();

type OperationSchemaPosition = "input" | "output";

/**
 * Compiled operation schemas, keyed by OBI document identity and canonical
 * operation/member address. The document is the JSON Schema resolution root;
 * extracting the member and compiling it alone changes the meaning of legal
 * same-document references such as
 * `#/operations/list/output/$defs/Item` (OBI-D-16 / OBI-T-16).
 */
const compiledOperationSchemaCache = new WeakMap<
  object,
  Map<string, CompiledSchema>
>();

/**
 * Compiles an operation input/output schema while preserving the complete OBI
 * document as its resolution scope. `operationName` is the canonical map key,
 * not an alias.
 */
export function compileOperationSchema(
  iface: OBInterface,
  operationName: string,
  position: OperationSchemaPosition,
): CompiledSchema {
  const operation = iface.operations?.[operationName];
  const schema = operation?.[position];
  if (schema == null) {
    throw new Error(`operation ${JSON.stringify(operationName)} has no ${position} schema`);
  }

  const cacheKey = `${operationName}\u0000${position}`;
  const cached = compiledOperationSchemaCache.get(iface)?.get(cacheKey);
  if (cached) return cached;

  const closure = operationSchemaClosure(iface, operationName, position);
  const document: Record<string, unknown> = closure ?? structuredClone(iface);
  // The OBI root is a resolution container, not itself a JSON Schema. Ignore
  // every root field that happens to spell a JSON Schema keyword; Core says
  // unknown OBI fields are ignored, so (for example) an unknown root `type`
  // must not constrain an operation value merely because a generic validator
  // recognizes it. Non-keyword extension fields remain pointer-addressable.
  stripDocumentRootSchemaKeywords(document);
  document.$ref = `#/operations/${escapePointerToken(operationName)}/${position}`;

  const compiled = compileDocumentRootSchema(
    document,
    operationSchemaRoots(document),
  );
  let entries = compiledOperationSchemaCache.get(iface);
  if (!entries) {
    entries = new Map();
    compiledOperationSchemaCache.set(iface, entries);
  }
  entries.set(cacheKey, compiled);
  return compiled;
}

/**
 * Builds the smallest complete same-document pointer closure for the common
 * resource-free case. A schema with `$id`/anchors or a non-fragment reference
 * falls back to the full-document path above because its base-resource rules
 * need the complete resource index. Ordinary `#/...` graphs — including
 * cycles and cross-operation pointers — compile in work proportional to the
 * reachable contract instead of total OBI size.
 */
function operationSchemaClosure(
  iface: OBInterface,
  operationName: string,
  position: OperationSchemaPosition,
): Record<string, unknown> | undefined {
  const rootSchema = iface.operations[operationName]?.[position];
  if (rootSchema == null || hasResourceControl(rootSchema)) return undefined;

  const document: Record<string, unknown> = {
    operations: {
      [operationName]: {
        [position]: structuredClone(rootSchema),
      },
    },
  };
  const visitedReferences = new Set<string>();
  const visitedValues = new WeakSet<object>();
  const pending: unknown[] = [rootSchema];

  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || visitedValues.has(value)) continue;
    visitedValues.add(value);
    if (Array.isArray(value)) {
      for (const child of value) pending.push(child);
      continue;
    }
    const object = value as Record<string, unknown>;
    if (hasResourceControl(object)) return undefined;
    for (const keyword of ["$ref", "$dynamicRef"] as const) {
      const reference = object[keyword];
      if (typeof reference !== "string" || visitedReferences.has(reference)) continue;
      visitedReferences.add(reference);
      if (reference === "#") continue;
      if (!reference.startsWith("#/")) return undefined;
      const target = resolveDocumentPointer(iface, reference.slice(1));
      if (target === undefined) return undefined;
      if (hasResourceControl(target)) return undefined;
      setDocumentPointer(document, reference.slice(1), structuredClone(target));
      pending.push(target);
    }
    for (const child of Object.values(object)) pending.push(child);
  }
  return document;
}

function hasResourceControl(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return typeof object.$id === "string" ||
    typeof object.$anchor === "string" ||
    typeof object.$dynamicAnchor === "string";
}

function resolveDocumentPointer(root: unknown, pointer: string): unknown {
  let value = root;
  for (const token of pointer.split("/").slice(1)) {
    if (typeof value !== "object" || value === null) return undefined;
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function setDocumentPointer(
  root: Record<string, unknown>,
  pointer: string,
  target: unknown,
): void {
  const tokens = pointer.split("/").slice(1)
    .map(token => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  let value = root;
  for (let index = 0; index < tokens.length - 1; index++) {
    const token = tokens[index]!;
    const current = value[token];
    if (typeof current === "object" && current !== null && !Array.isArray(current)) {
      value = current as Record<string, unknown>;
    } else {
      const child: Record<string, unknown> = {};
      value[token] = child;
      value = child;
    }
  }
  const last = tokens.at(-1);
  if (last !== undefined) value[last] = target;
}

function stripDocumentRootSchemaKeywords(document: Record<string, unknown>): void {
  for (const keyword of OBI_BOUNDARY_DRAFT.keywords) {
    delete document[keyword.keyword];
  }
  // Dialect/resource controls are not all represented as ordinary assertion
  // or annotation keywords by validator backends.
  for (const keyword of ["$id", "$schema", "$anchor", "$dynamicAnchor", "$vocabulary", "$comment"]) {
    delete document[keyword];
  }
}

function escapePointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Returns every Core-defined schema root in a cloned OBI document. */
function operationSchemaRoots(document: Record<string, unknown>): unknown[] {
  const roots: unknown[] = [];
  const schemas = document.schemas;
  if (isObj(schemas)) roots.push(...Object.values(schemas));
  const operations = document.operations;
  if (isObj(operations)) {
    for (const operation of Object.values(operations)) {
      if (!isObj(operation)) continue;
      if (operation.input !== undefined) roots.push(operation.input);
      if (operation.output !== undefined) roots.push(operation.output);
    }
  }
  return roots;
}

/**
 * Compiles an isolated schema with a named schema map exposed under `$defs`.
 * This helper cannot preserve arbitrary references into an OBI document
 * because it does not receive that document; interface-aware callers use
 * compileOperationSchema instead.
 */
export function compileExampleSchema(
  schema: unknown,
  defs: Record<string, unknown> | undefined,
): CompiledSchema {
  const cacheable = typeof schema === "object" && schema !== null;
  const defsKey = defs ?? NO_DEFS;
  if (cacheable) {
    const hit = compiledSchemaCache.get(schema)?.get(defsKey);
    if (hit) return hit;
  }
  const compiled = compileExampleSchemaUncached(schema, defs);
  if (cacheable) {
    let byDefs = compiledSchemaCache.get(schema);
    if (!byDefs) {
      byDefs = new WeakMap();
      compiledSchemaCache.set(schema, byDefs);
    }
    byDefs.set(defsKey, compiled);
  }
  return compiled;
}

function compileExampleSchemaUncached(
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
 * Compiles a schema whose root is a JSON-Schema view of an OBI document. The
 * injected root `$ref` selects the governing operation schema while leaving
 * all document-root JSON Pointers intact. Reachable nodes are meta-validated
 * individually because the Core fields that contain schemas are deliberately
 * unknown keywords to a generic JSON Schema meta-validator.
 */
function compileDocumentRootSchema(
  root: Record<string, unknown>,
  schemaRoots: unknown[],
): CompiledSchema {
  assertFullyResolvable(root, schemaRoots, true);
  const remotes = embeddedIDResources(schemaRoots);
  const options = {
    drafts: [OBI_BOUNDARY_DRAFT],
    formatAssertion: false as const,
  };
  if (remotes.length > 0) {
    const [first, ...rest] = remotes;
    const remote = compileSchema(first!, options);
    for (const resource of rest) {
      remote.addRemoteSchema(String(resource.$id), resource);
    }
    return wrapNode(compileSchema(root, { ...options, remote }));
  }
  return wrapNode(compileSchema(root, {
    ...options,
  }));
}

/**
 * Finds the outermost embedded resources beneath each Core-defined schema
 * position. Once a resource is registered, the backend discovers nested `$id`
 * resources through ordinary JSON Schema keyword traversal.
 */
function embeddedIDResources(schemaRoots: unknown[]): Record<string, unknown>[] {
  const resources: Record<string, unknown>[] = [];
  const visit = (node: unknown): void => {
    if (!isObj(node)) return;
    if (typeof node.$id === "string") {
      resources.push(node);
      return;
    }
    walkSchemaChildren(node, visit);
  };
  for (const root of schemaRoots) visit(root);
  return resources;
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
function assertFullyResolvable(
  root: Record<string, unknown>,
  additionalSchemaRoots: unknown[] = [],
  validateReachableSchemas = false,
): void {
  // Pass 1 (lexical): collect embedded $id resources across the whole
  // compound — identity resolution is in-document wherever the resource
  // sits (§10), even inside an entry nothing references directly.
  const idResources = new Map<string, Record<string, unknown>>();
  const collectIds = (node: unknown): void => {
    if (!isObj(node)) return;
    if (typeof node.$id === "string") idResources.set(node.$id.replace(/#$/, ""), node);
    walkSchemaChildren(node, collectIds);
  };
  collectIds(root);
  for (const schemaRoot of additionalSchemaRoots) collectIds(schemaRoot);

  // Pass 2 (reachable): follow keyword subschemas and $ref targets from
  // the governing root only.
  const visited = new Set<unknown>();
  (function visit(node: unknown, scope: Record<string, unknown>, base: string): void {
    if (typeof node === "boolean") return;
    if (!isObj(node)) {
      if (validateReachableSchemas) {
        throw new Error(`schema does not conform to JSON Schema 2020-12: expected an object or boolean schema`);
      }
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    if (validateReachableSchemas) {
      const meta = metaValidator().validate(node);
      if (!meta.valid) {
        const first = meta.failures[0] ?? { path: "", message: "schema violation" };
        throw new Error(
          `schema does not conform to JSON Schema 2020-12: ${first.path ? first.path + ": " : ""}${first.message}`,
        );
      }
    }
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
 * Memoised per `schemas` object. Building the defs deep-clones and rewrites
 * every document schema, and an invoker rebuilds it on every invocation — for
 * a document whose schemas are large that dominated the cost of making a call.
 *
 * Keyed on object identity, so this is only sound while documents are treated
 * as values. Every SDK path that changes a document produces a new object;
 * mutating a schema in place would be observed as stale here, which is the
 * same assumption the rest of the document model already makes.
 */
const schemaDefsCache = new WeakMap<object, Record<string, unknown>>();

/**
 * Builds the document's `schemas` map ready to be embedded under `$defs`,
 * with internal `#/schemas/` refs rewritten to `#/$defs/`.
 */
export function buildSchemaDefs(
  schemas: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!schemas || Object.keys(schemas).length === 0) return undefined;
  const cached = schemaDefsCache.get(schemas);
  if (cached) return cached;
  const out: Record<string, unknown> = {};
  for (const [name, sch] of Object.entries(schemas)) {
    const copy = structuredClone(sch);
    if (typeof copy === "object" && copy !== null) {
      rewriteSchemaRefs(copy);
    }
    out[name] = copy;
  }
  schemaDefsCache.set(schemas, out);
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

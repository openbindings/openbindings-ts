/**
 * OBI-D-02 (validate document against openbindings.schema.json) and
 * OBI-D-11 (validate every example.input/output against its operation's
 * input/output schema). Also exposes helpers used by OperationInvoker
 * for OBI-T-07/T-08 runtime validation.
 *
 * Validator backend: @cfworker/json-schema. Pure ES, tree-walking, no
 * `eval` / `new Function()`. Works across the SDK's target runtimes
 * (Cloudflare Workers, Vercel Edge, Netlify Edge, Deno Deploy, Node
 * 18+, modern browsers including CSP-strict, Bun, AWS Lambda).
 *
 * The choice of validator backend is an internal implementation detail;
 * the SDK's public error and result types are stable across any future
 * swap. See STABILITY.md.
 */
import {
  Validator,
  schemaArrayKeyword,
  schemaKeyword,
  schemaMapKeyword,
  type OutputUnit,
} from "@cfworker/json-schema";
import type { OBInterface } from "./types.js";
import obiSchema from "./openbindings.schema.json" with { type: "json" };

let _documentValidator: Validator | null = null;

function documentValidator(): Validator {
  if (_documentValidator) return _documentValidator;
  _documentValidator = new Validator(obiSchema as object, "2020-12");
  return _documentValidator;
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
  for (const e of result.errors ?? []) {
    const path = e.instanceLocation || "";
    const msg = `${path ? path + ": " : ""}${e.error ?? "schema violation"}`;
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
  const operations = iface.operations ?? {};
  const opKeys = Object.keys(operations);
  if (opKeys.length === 0) return;
  const defs = buildSchemaDefs(iface.schemas);
  // If any document schema carries an external $ref, the compound schema
  // space is not fully resolvable locally; abstain across the board.
  const defsExternal = schemaHasExternalRef(defs);
  for (const opKey of opKeys) {
    const op = operations[opKey];
    if (!op.examples) continue;

    let inputValidator: Validator | undefined;
    let outputValidator: Validator | undefined;
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
    for (const exKey of Object.keys(op.examples)) {
      const ex = op.examples[exKey];
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
 * abstains from example checks against them.
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
 * OperationInvoker (OBI-T-07 / OBI-T-08).
 */
export function compileExampleSchema(
  schema: unknown,
  defs: Record<string, unknown> | undefined,
): Validator {
  const root = stripFormatAssertions(buildCompoundSchema(schema, defs));
  return new Validator(root as object, "2020-12");
}

/**
 * Copy of a schema tree with `format` keywords removed. §6.2: at OBI
 * validation boundaries `format` is an annotation, never an assertion —
 * the validator backend asserts known formats unconditionally, so the
 * compiled view drops the keyword. Recursion follows the backend's own
 * keyword-shape tables, so a property NAMED "format" (a key under
 * `properties`, `$defs`, ...) is untouched. Non-schema members are shared
 * by reference: the copy never mutates its input.
 */
function stripFormatAssertions(node: unknown): unknown {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    return node;
  }
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === "format") continue;
    if (schemaKeyword[k] && typeof v === "object" && v !== null && !Array.isArray(v)) {
      out[k] = stripFormatAssertions(v);
    } else if (schemaArrayKeyword[k] && Array.isArray(v)) {
      out[k] = v.map(stripFormatAssertions);
    } else if (schemaMapKeyword[k] && typeof v === "object" && v !== null && !Array.isArray(v)) {
      const m: Record<string, unknown> = {};
      for (const [mk, mv] of Object.entries(v as Record<string, unknown>)) {
        m[mk] = stripFormatAssertions(mv);
      }
      out[k] = m;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * A single validation failure surfaced in a stable, validator-agnostic
 * shape. Multiple failures can come from a single validate() call when
 * the schema has multiple constraints violated by the value.
 *
 * The fields mirror what JSON Schema 2020-12 produces, translated from
 * the underlying validator's vocabulary so SDK consumers don't depend
 * on cfworker (or any future replacement) directly.
 */
export interface ValidationFailure {
  /** JSON Pointer into the instance, e.g. "/results/0/name". Empty string for the root. */
  path: string;
  /** Human-readable diagnostic (e.g., "Instance type \"null\" is invalid. Expected \"string\"."). */
  message: string;
  /** Optional JSON Pointer into the schema (e.g., "/properties/previous/type"). */
  schemaPath?: string;
}

/**
 * Wraps Validator.validate to translate the result into a stable
 * SDK-internal shape and to catch any thrown errors (the underlying
 * validator may throw on inputs JSON cannot represent, e.g.
 * `undefined`). Callers see an SDK-defined error contract rather than
 * the underlying validator's API.
 */
export function safeValidate(
  validator: Validator,
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
  const failures: ValidationFailure[] = (result.errors ?? []).map((e: OutputUnit) => ({
    path: e.instanceLocation ?? "",
    message: e.error ?? "schema violation",
    schemaPath: e.keywordLocation,
  }));
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
        if (!(k in merged)) merged[k] = v;
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


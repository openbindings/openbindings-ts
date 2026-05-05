// OBI-D-02 (validate document against openbindings.schema.json) and
// OBI-D-15 (validate every example.input/output against its operation's
// input/output schema, with `$ref: "#/schemas/<name>"` resolving into the
// document's `schemas` map) enforcement, backed by Ajv 2020-12.
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import obiSchema from "./openbindings.schema.json" with { type: "json" };
import type { OBInterface, JSONSchema } from "./types.js";

const documentValidator = (() => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(obiSchema as object);
})();

/**
 * Reports OBI-D-02 violations: the document does not validate against
 * openbindings.schema.json. Errors are appended to errs with the OBI-D-02 tag.
 */
export function validateAgainstOBISchema(errs: string[], iface: unknown): void {
  if (documentValidator(iface)) return;
  for (const e of documentValidator.errors ?? []) {
    const path = e.instancePath || "";
    const msg = `${path ? path + ": " : ""}${e.message ?? "schema violation"}`;
    errs.push(`schema validation: ${msg} (OBI-D-02)`);
  }
}

/**
 * Reports OBI-D-15 violations: every example.input/output that has its
 * operation's input/output schema specified must validate against that
 * schema. The operation's schema may $ref into the document's schemas map
 * via `#/schemas/<name>`; those refs are rewritten to `#/$defs/<name>` and a
 * synthetic compound schema is compiled with the document's schemas exposed
 * under $defs.
 */
export function validateExamplesAgainstOpSchemas(errs: string[], iface: OBInterface): void {
  const operations = iface.operations ?? {};
  const opKeys = Object.keys(operations);
  if (opKeys.length === 0) return;
  const defs = buildSchemaDefs(iface.schemas);
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const opKey of opKeys) {
    const op = operations[opKey];
    if (!op.examples) continue;
    let inputValidator: ReturnType<typeof ajv.compile> | undefined;
    let outputValidator: ReturnType<typeof ajv.compile> | undefined;
    if (op.input != null) {
      try {
        inputValidator = ajv.compile(buildExampleSchema(op.input, defs));
      } catch (err) {
        errs.push(`operations["${opKey}"].input: cannot compile schema: ${(err as Error).message} (OBI-D-15)`);
      }
    }
    if (op.output != null) {
      try {
        outputValidator = ajv.compile(buildExampleSchema(op.output, defs));
      } catch (err) {
        errs.push(`operations["${opKey}"].output: cannot compile schema: ${(err as Error).message} (OBI-D-15)`);
      }
    }
    for (const exKey of Object.keys(op.examples)) {
      const ex = op.examples[exKey];
      if (ex.input !== undefined && inputValidator && !inputValidator(ex.input)) {
        for (const e of inputValidator.errors ?? []) {
          const path = e.instancePath || "";
          const msg = `${path ? path + ": " : ""}${e.message ?? "schema violation"}`;
          errs.push(`operations["${opKey}"].examples["${exKey}"].input: ${msg} (OBI-D-15)`);
        }
      }
      if (ex.output !== undefined && outputValidator && !outputValidator(ex.output)) {
        for (const e of outputValidator.errors ?? []) {
          const path = e.instancePath || "";
          const msg = `${path ? path + ": " : ""}${e.message ?? "schema violation"}`;
          errs.push(`operations["${opKey}"].examples["${exKey}"].output: ${msg} (OBI-D-15)`);
        }
      }
    }
  }
}

export function buildSchemaDefs(schemas: Record<string, JSONSchema> | undefined): Record<string, unknown> | undefined {
  if (!schemas || Object.keys(schemas).length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const [name, sch] of Object.entries(schemas)) {
    out[name] = rewriteSchemaRefs(deepCopyJSON(sch));
  }
  return out;
}

export function buildExampleSchema(opSchema: unknown, defs: Record<string, unknown> | undefined): object {
  const root = deepCopyJSON(opSchema);
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    throw new Error("operation schema must be a JSON object");
  }
  const rootObj = root as Record<string, unknown>;
  rewriteSchemaRefs(rootObj);
  if (defs) {
    const existing = rootObj.$defs;
    if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
      const merged = existing as Record<string, unknown>;
      for (const [k, v] of Object.entries(defs)) {
        if (!(k in merged)) merged[k] = v;
      }
    } else {
      rootObj.$defs = defs;
    }
  }
  return rootObj;
}

function rewriteSchemaRefs(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const child of value) rewriteSchemaRefs(child);
  } else if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const ref = obj.$ref;
    if (typeof ref === "string" && ref.startsWith("#/schemas/")) {
      obj.$ref = "#/$defs/" + ref.slice("#/schemas/".length);
    }
    for (const child of Object.values(obj)) rewriteSchemaRefs(child);
  }
  return value;
}

function deepCopyJSON<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => deepCopyJSON(v)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = deepCopyJSON(v);
  }
  return out as unknown as T;
}

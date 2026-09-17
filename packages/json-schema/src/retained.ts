/** Numeric predicates only. The upstream evaluator owns traversal, reference
 * scope, applicators and annotations. No second validation walk is introduced. */
import { compileSchema, draft2020, isJsonError } from "json-schema-library";
import type { Draft, JsonError, Keyword, SchemaNode } from "json-schema-library";
import {
  compareNumberTokens as compare, integerNumberToken as integer,
  multipleNumberTokens as multiple, numberToken as token,
  equalJSON, isJSONNumber, stringifyJSON,
} from "@openbindings/json";

import { valueInstance, stringValue, projectInstance, prepareValue } from "./values.js";
import type { RetainedValue, ValueAccess, ValueCosts } from "@openbindings/json/values";

// Retired by the value-api-shape loop. Everything here keeps working until
// Block 8 deletes it; the replacements are `compile` and `Schema.validate`.

const bounds = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]);
const counts = new Set(["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]);
const objects = new Set(["properties", "patternProperties", "additionalProperties", "unevaluatedProperties",
  "required", "dependentRequired", "dependentSchemas", "propertyNames"]);
const codes: Record<string, string> = {
  minimum: "minimum-error", maximum: "maximum-error", exclusiveMinimum: "exclusive-minimum-error",
  exclusiveMaximum: "exclusive-maximum-error", multipleOf: "multiple-of-error",
  minLength: "min-length-error", maxLength: "max-length-error", minItems: "min-items-error",
  maxItems: "max-items-error", minProperties: "min-properties-error", maxProperties: "max-properties-error",
};
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) && !isJSONNumber(v);
const error = (node: SchemaNode, code: string, pointer: string, value: unknown, details: Record<string, unknown> = {}) =>
  node.createError(code, { pointer, schema: node.schema, value, ...details });

/** Render from structured JSON operands, before any native serialization. */
function errors(project: (value: unknown) => unknown = value => value): Draft["errors"] {
  return Object.fromEntries(Object.entries(draft2020.errors).map(([code, template]) => [code,
    typeof template !== "string" || !code.endsWith("-error") ? template : (data: Record<string, unknown>): JsonError => ({
      type: "error", code, data: data as JsonError["data"],
      message: template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
        const value = data[key];
        if (value === undefined) return ""; // optional backend metadata, never a JSON member
        // Backend match records contain executable SchemaNodes. Expose their
        // branch indices, not internal objects or additional instance data.
        if (key === "matches" && Array.isArray(value)) return JSON.stringify((value as {index:unknown}[]).map(v => v.index));
        const logical = project(value);
        return typeof logical === "string" ? logical : stringifyJSON(logical);
      }),
    }),
  ]));
}

function numericKeyword(original: Keyword, retained = false): Keyword {
  const key = original.keyword;
  const operand = (value: unknown) => retained ? projectInstance(value, "schema-constraint") : value;
  const isObject = (value: unknown): value is Record<string, unknown> => object(value) && !(retained && stringValue(value));
  const k: Keyword = { ...original };
  if (bounds.has(key) || counts.has(key)) {
    k.addValidate = node => Object.hasOwn(node.schema, key);
    k.parse = node => {
      if (!Object.hasOwn(node.schema, key)) return;
      const t = token(node.schema[key]);
      if (t === undefined || (counts.has(key) && (!integer(t) || compare(t, "0") < 0))
        || (key === "multipleOf" && compare(t, "0") <= 0)) {
        return error(node, "schema-error", `${node.schemaLocation}/${key}`, node.schema[key], { message: `Invalid ${key}` });
      }
      compare(t, t); // fail capability explicitly at compilation, not as invalid data
    };
    k.validate = ({ node, data, pointer }) => {
      let t = token(data), length: unknown = data;
      if (counts.has(key)) {
        const n = key.endsWith("Items") ? (Array.isArray(data) ? data.length : undefined)
          : key.endsWith("Length") ? (typeof data === "string" ? [...data].length : retained ? stringValue(data)?.length : undefined)
          : isObject(data) ? Object.keys(data).length : undefined;
        if (n === undefined) return;
        t = String(n); length = n;
      }
      if (t === undefined) return;
      const limit = token(node.schema[key])!;
      const c = compare(t, limit);
      const valid = key === "multipleOf" ? multiple(t, limit) : key === "exclusiveMinimum" ? c > 0
        : key === "exclusiveMaximum" ? c < 0 : key.startsWith("min") ? c >= 0 : c <= 0;
      const bound: unknown = node.schema[key];
      if (!valid) return error(node, codes[key]!, pointer, data, {
        [key]: bound, length,
        minimum: bound, maximum: bound,
      });
    };
  } else if (key === "type") {
    k.validate = ({ node, data, pointer }) => {
      if (data === undefined) return;
      const types = Array.isArray(node.type) ? node.type : [node.type], t = token(data);
      const received = t !== undefined ? (integer(t) ? "integer" : "number")
        : data === null ? "null" : Array.isArray(data) ? "array" : retained && stringValue(data) ? "string" : typeof data;
      const valid = t !== undefined ? types.includes("number") || (types.includes("integer") && received === "integer") : types.includes(received);
      if (!valid) return error(node, "type-error", pointer, data, { expected: node.type, received });
    };
    k.reduce = p => isJSONNumber(p.data) || retained && stringValue(p.data) ? undefined : original.reduce?.(p);
  } else if (key === "const") {
    k.validate = ({ node, data, pointer }) => equalJSON(operand(data), node.schema.const) ? undefined
      : error(node, "const-error", pointer, data, { expected: node.schema.const });
  } else if (key === "enum") {
    k.validate = ({ node, data, pointer }) => node.enum?.some(v => equalJSON(v, operand(data))) ? undefined
      : error(node, "enum-error", pointer, data, { values: node.enum });
  } else if (key === "uniqueItems") {
    k.validate = ({ node, data, pointer }) => {
      if (!Array.isArray(data) || node.schema.uniqueItems !== true) return;
      for (let a = 0; a < data.length; a++) for (let b = 0; b < a; b++) {
        if (equalJSON(operand(data[a]), operand(data[b]))) return error(node, "unique-items-error", `${pointer}/${a}`, data[a], { duplicatePointer: `${pointer}/${b}` });
      }
    };
  } else if (key === "pattern" && retained) {
    k.validate = p => original.validate!({ ...p, data: stringValue(p.data)?.scalar("schema-constraint") ?? p.data });
  } else if (key === "contains") {
    k.validate = p => {
      const schema = { ...p.node.schema };
      for (const name of ["minContains", "maxContains"]) if (Object.hasOwn(schema, name)) {
        const t = token(schema[name]);
        if (t === undefined || !integer(t) || compare(t, "0") < 0) throw new TypeError(`Invalid ${name}`);
        // Private comparison view: every materializable JS array is shorter
        // than this sentinel. The authored schema/diagnostic remains exact.
        schema[name] = compare(t, "9007199254740991") > 0 ? Number.MAX_SAFE_INTEGER : Number(t);
      }
      const result = original.validate!({ ...p, node: { ...p.node, schema } });
      if (isJsonError(result)) {
        const { delta: _privateDelta, ...details } = result.data;
        return {
          ...result, data: { ...details, schema: p.node.schema },
          message: `Array at ${p.pointer} does not satisfy contains occurrence bounds in ${stringifyJSON(p.node.schema)}`,
        };
      }
      return result;
    };
  } else if (key === "oneOf") {
    // This backend pre-stringifies the top-level failure value. Replace that
    // metadata from its original operand, never by editing rendered text.
    k.validate = p => {
      const result = original.validate!(p);
      return isJsonError(result) && result.code === "one-of-error"
        ? p.node.createError(result.code, { ...result.data, value: p.data }) : result;
    };
  }
  if (objects.has(key) && k.validate) {
    const validate = k.validate;
    k.validate = p => isJSONNumber(p.data) || retained && stringValue(p.data) ? undefined : validate(p);
  }
  return k;
}

/** @deprecated Use `compile`, whose draft reads Decimal and Encoded leaves in place. */
export const EXACT_DRAFT_2020: Draft = {
  ...draft2020, formats: {}, errors: errors(),
  // 2020-12 treats the retired dependencies keyword as an annotation.
  keywords: draft2020.keywords.filter(k => k.keyword !== "dependencies").map(k => numericKeyword(k)),
};

/** The same upstream traversal with retained scalar dispatch and forcing.
 * @deprecated Use `compile`, whose draft reads Decimal and Encoded leaves in place. */
export const RETAINED_DRAFT_2020: Draft = {
  ...draft2020, formats: {}, errors: errors(value => projectInstance(value, "diagnostic")),
  keywords: draft2020.keywords.filter(k => k.keyword !== "dependencies").map(k => numericKeyword(k, true)),
};

/** Standalone retained validation; no invocation, binding or JSONata dependency.
 * @deprecated Use `Validation` from `compile(...).validate(...)`. */
export type ValueValidation = ReturnType<SchemaNode["validate"]> & { readonly costs: ValueCosts };
/** @deprecated Use `Schema` from `compile`. */
export interface ValueSchema {
  validate(value: RetainedValue): ValueValidation;
  validate<T>(value: T, access: ValueAccess<T>): ValueValidation;
}
/** @deprecated Use `compile(schema, options).validate(value)`; the value is plain data with rich leaves and needs no retained handle. */
export function compileValueSchema(
  schema: Parameters<typeof compileSchema>[0],
  options?: Omit<NonNullable<Parameters<typeof compileSchema>[1]>, "drafts">,
): ValueSchema {
  const node = compileSchema(schema, { throwOnInvalidRef:true, ...options, drafts: [RETAINED_DRAFT_2020] });
  return Object.freeze({ validate: <T>(value: T, access?: ValueAccess<T>): ValueValidation => {
    const prepared = prepareValue(value,access);
    const result = node.validate(prepared.instance);
    // Snapshot numbers; a successful report must not retain its input through
    // a statistics closure. Later user-requested diagnostic exports are separate.
    return { ...result, costs:prepared.costs() };
  } });
}


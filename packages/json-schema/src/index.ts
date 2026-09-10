/** Numeric predicates only. The upstream evaluator owns traversal, reference
 * scope, applicators and annotations. No second validation walk is introduced. */
import { draft2020, isJsonError } from "json-schema-library";
import type { Draft, JsonError, Keyword, SchemaNode } from "json-schema-library";
import {
  compareNumberTokens as compare, integerNumberToken as integer,
  multipleNumberTokens as multiple, numberToken as token,
  equalJSON, isJSONNumber, stringifyJSON,
} from "@openbindings/json";

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
function errors(): Draft["errors"] {
  return Object.fromEntries(Object.entries(draft2020.errors).map(([code, template]) => [code,
    typeof template !== "string" || !code.endsWith("-error") ? template : (data: Record<string, unknown>): JsonError => ({
      type: "error", code, data: data as JsonError["data"],
      message: template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
        const value = data[key];
        if (value === undefined) return ""; // optional backend metadata, never a JSON member
        // Backend match records contain executable SchemaNodes. Expose their
        // branch indices, not internal objects or additional instance data.
        if (key === "matches" && Array.isArray(value)) return JSON.stringify(value.map(v => v.index));
        return typeof value === "string" ? value : stringifyJSON(value);
      }),
    }),
  ]));
}

function numericKeyword(original: Keyword): Keyword {
  const key = original.keyword;
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
          : key.endsWith("Length") ? (typeof data === "string" ? [...data].length : undefined)
          : object(data) ? Object.keys(data).length : undefined;
        if (n === undefined) return;
        t = String(n); length = n;
      }
      if (t === undefined) return;
      const limit = token(node.schema[key])!;
      const c = compare(t, limit);
      const valid = key === "multipleOf" ? multiple(t, limit) : key === "exclusiveMinimum" ? c > 0
        : key === "exclusiveMaximum" ? c < 0 : key.startsWith("min") ? c >= 0 : c <= 0;
      if (!valid) return error(node, codes[key]!, pointer, data, {
        [key]: node.schema[key], length,
        minimum: node.schema[key], maximum: node.schema[key],
      });
    };
  } else if (key === "type") {
    k.validate = ({ node, data, pointer }) => {
      if (data === undefined) return;
      const types = Array.isArray(node.type) ? node.type : [node.type], t = token(data);
      const received = t !== undefined ? (integer(t) ? "integer" : "number")
        : data === null ? "null" : Array.isArray(data) ? "array" : typeof data;
      const valid = t !== undefined ? types.includes("number") || (types.includes("integer") && received === "integer") : types.includes(received);
      if (!valid) return error(node, "type-error", pointer, data, { expected: node.type, received });
    };
    k.reduce = p => isJSONNumber(p.data) ? undefined : original.reduce?.(p);
  } else if (key === "const") {
    k.validate = ({ node, data, pointer }) => equalJSON(data, node.schema.const) ? undefined
      : error(node, "const-error", pointer, data, { expected: node.schema.const });
  } else if (key === "enum") {
    k.validate = ({ node, data, pointer }) => node.enum?.some(v => equalJSON(v, data)) ? undefined
      : error(node, "enum-error", pointer, data, { values: node.enum });
  } else if (key === "uniqueItems") {
    k.validate = ({ node, data, pointer }) => {
      if (!Array.isArray(data) || node.schema.uniqueItems !== true) return;
      for (let a = 0; a < data.length; a++) for (let b = 0; b < a; b++) {
        if (equalJSON(data[a], data[b])) return error(node, "unique-items-error", `${pointer}/${a}`, data[a], { duplicatePointer: `${pointer}/${b}` });
      }
    };
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
    k.validate = p => isJSONNumber(p.data) ? undefined : validate(p);
  }
  return k;
}

export const EXACT_DRAFT_2020: Draft = {
  ...draft2020, formats: {}, errors: errors(),
  // 2020-12 treats the retired dependencies keyword as an annotation.
  keywords: draft2020.keywords.filter(k => k.keyword !== "dependencies").map(numericKeyword),
};

export { compileSchema } from "json-schema-library";
export type { Draft, SchemaNode } from "json-schema-library";

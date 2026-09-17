/** The leaf-aware 2020-12 draft behind `compile`. The upstream evaluator owns
 * traversal, reference scope, applicators and annotations. The keywords here
 * change only how one node reads its data: a Decimal is a number, an Encoded
 * is a string, numbers compare as exact digits, and a forced string is
 * attributed to the keyword that needed it. No second validation walk and no
 * copy of the instance. Reached by `compile` only; not a public export. */
import { draft2020, isJsonError } from "json-schema-library";
import type { Draft, JsonError, Keyword, SchemaNode, ValidationReturnType } from "json-schema-library";
import { BASE64, JSONCapabilityError, ValueError, integerNumberToken, isDecimal, isEncoded, multipleNumberTokens } from "@openbindings/json";
import type { Decimal, Encoded } from "@openbindings/json";
import { compare } from "@openbindings/json/advanced";
import { codePointCount, equalEncoded, force } from "@openbindings/json/internal";

type Numeric = number | Decimal;
type Validator = NonNullable<Keyword["validate"]>;
type Params = Parameters<Validator>[0];

const bounds = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]);
const counts = new Set(["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]);
const objects = new Set(["properties", "patternProperties", "additionalProperties", "unevaluatedProperties",
  "required", "dependentRequired", "dependentSchemas", "propertyNames"]);
const restored = new Set(["oneOf", "unevaluatedProperties", "unevaluatedItems"]);
const codes: Record<string, string> = {
  minimum: "minimum-error", maximum: "maximum-error", exclusiveMinimum: "exclusive-minimum-error",
  exclusiveMaximum: "exclusive-maximum-error", multipleOf: "multiple-of-error",
  minLength: "min-length-error", maxLength: "max-length-error", minItems: "min-items-error",
  maxItems: "max-items-error", minProperties: "min-properties-error", maxProperties: "max-properties-error",
};

// ---------------------------------------------------------------------------
// Leaves
// ---------------------------------------------------------------------------

const leaf = (value: unknown): value is Decimal | Encoded => isDecimal(value) || isEncoded(value);
const numeric = (value: unknown): value is Numeric => (typeof value === "number" && Number.isFinite(value)) || isDecimal(value);
const textual = (value: unknown): value is string | Encoded => typeof value === "string" || isEncoded(value);
const container = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && !leaf(value);

/** The exact digits of a number: a primitive prints in shortest form. */
const digits = (value: Numeric): string => typeof value === "number" ? (value === 0 ? "0" : String(value)) : value.raw.rawJSON;

/** The characters a character keyword needs, produced once and kept on the leaf. */
const text = (value: string | Encoded): string => typeof value === "string" ? value : force(value, "schema-constraint");

/** Run one exact predicate. Its work limit is the codec's ERR_JSON_BUDGET here as there. */
function exact<T>(predicate: () => T): T {
  try { return predicate(); }
  catch (cause) {
    if (cause instanceof JSONCapabilityError) {
      throw new ValueError("ERR_JSON_BUDGET", "Numeric comparison exceeds its work limit (4,096 token characters or an exponent beyond 10,000)", { details: { reason: "numeric-predicate" }, cause });
    }
    throw cause;
  }
}
const integral = (value: Numeric): boolean => typeof value === "number" ? Number.isInteger(value) : exact(() => integerNumberToken(value.raw.rawJSON));
const multiple = (value: Numeric, of: Numeric): boolean => exact(() => multipleNumberTokens(digits(value), digits(of)));

/** Logical equality for const, enum and uniqueItems, read in place. Numbers
 * compare by exact value; two Base64 leaves compare by bytes without any
 * encode; any other Encoded is forced once under "schema-constraint". */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const na = numeric(a), nb = numeric(b);
  if (na || nb) return na && nb && compare(a, b) === 0;
  const sa = textual(a), sb = textual(b);
  if (sa || sb) {
    if (!(sa && sb)) return false;
    if (isEncoded(a) && isEncoded(b) && a.encoding === BASE64 && b.encoding === BASE64) return equalEncoded(a, b);
    return text(a) === text(b);
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => same(item, b[i]));
  }
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>, keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every(key => Object.hasOwn(y, key) && same(x[key], y[key]));
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** JSON text of an operand for a message. Decimal digits are written; an
 * Encoded is forced under "diagnostic". Never "[object Object]". */
function show(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? digits(value) : String(value);
  if (isDecimal(value)) return value.raw.rawJSON;
  if (isEncoded(value)) return JSON.stringify(force(value, "diagnostic"));
  if (Array.isArray(value)) return "[" + value.map(show).join(",") + "]";
  if (typeof value === "object") {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return String(value);
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).map(key => JSON.stringify(key) + ":" + show(record[key])).join(",") + "}";
  }
  return String(value);
}

/** The draft's message templates, rendered from structured operands. */
function templates(): Draft["errors"] {
  return Object.fromEntries(Object.entries(draft2020.errors).map(([code, template]) => [code,
    typeof template !== "string" || !code.endsWith("-error") ? template : (data: Record<string, unknown>): JsonError => ({
      type: "error", code, data: data as JsonError["data"],
      message: template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
        const value = data[key];
        if (value === undefined) return ""; // optional backend metadata, never a JSON member
        // Backend match records hold executable SchemaNodes. Show their branch indices only.
        if (key === "matches" && Array.isArray(value)) return JSON.stringify((value as { index: unknown }[]).map(v => v.index));
        return typeof value === "string" ? value : show(value);
      }),
    }),
  ]));
}

const error = (node: SchemaNode, code: string, pointer: string, value: unknown, details: Record<string, unknown> = {}): JsonError =>
  node.createError(code, { pointer, schema: node.schema, value, ...details });

/** The member of `data` at a pointer relative to the node, as the upstream
 * writes it (segments joined by "/", not escaped). */
function memberAt(data: unknown, relative: string): unknown {
  let current = data;
  for (const segment of relative.split("/")) {
    if (Array.isArray(current)) current = current[Number(segment)];
    else if (container(current) && Object.hasOwn(current, segment)) current = current[segment];
    else return undefined;
  }
  return current;
}

/** Some upstream applicators serialize the offending member into the error's
 * `value`. Put the member itself back so `data.value` shares it. */
function restore(p: Params, result: ValidationReturnType): ValidationReturnType {
  const fix = (r: unknown): unknown => {
    if (!isJsonError(r) || typeof r.data.value !== "string") return r;
    if (r.code === "one-of-error") return p.node.createError(r.code, { ...r.data, value: p.data });
    if (r.code === "unevaluated-property-error" || r.code === "unevaluated-items-error") {
      const member = memberAt(p.data, r.data.pointer.slice(p.pointer.length + 1));
      return member === undefined ? r : p.node.createError(r.code, { ...r.data, value: member });
    }
    return r;
  };
  return (Array.isArray(result) ? result.map(fix) : fix(result)) as ValidationReturnType;
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

function leafKeyword(original: Keyword): Keyword {
  const key = original.keyword;
  const k: Keyword = { ...original };
  if (bounds.has(key) || counts.has(key)) {
    k.addValidate = node => (node as unknown as Record<string, unknown>)[key] !== undefined;
    k.parse = node => {
      if (!Object.hasOwn(node.schema, key)) return;
      const bound: unknown = node.schema[key];
      // integral() also runs the codec's token limits, so an unusable bound
      // fails at compilation and never as invalid data.
      const usable = numeric(bound) && (integral(bound) || !counts.has(key))
        && (!counts.has(key) || compare(bound, 0) >= 0) && (key !== "multipleOf" || compare(bound, 0) > 0);
      if (!usable) return error(node, "schema-error", `${node.schemaLocation}/${key}`, bound, { message: `Invalid ${key}` });
      (node as unknown as Record<string, unknown>)[key] = bound;
    };
    k.validate = ({ node, data, pointer }) => {
      const bound = node.schema[key] as Numeric;
      let measured: Numeric, length: unknown = data;
      if (counts.has(key)) {
        const n = key.endsWith("Items") ? (Array.isArray(data) ? data.length : undefined)
          : key.endsWith("Length") ? (typeof data === "string" ? codePointCount(data) : isEncoded(data) ? data.length : undefined)
          : container(data) ? Object.keys(data).length : undefined;
        if (n === undefined) return;
        measured = n; length = n;
      } else if (numeric(data)) measured = data;
      else return;
      let valid: boolean;
      if (key === "multipleOf") valid = multiple(measured, bound);
      else {
        const c = compare(measured, bound);
        valid = key === "exclusiveMinimum" ? c > 0 : key === "exclusiveMaximum" ? c < 0 : key.startsWith("min") ? c >= 0 : c <= 0;
      }
      if (!valid) return error(node, codes[key]!, pointer, data, { [key]: bound, length, minimum: bound, maximum: bound });
    };
  } else if (key === "type") {
    k.validate = ({ node, data, pointer }) => {
      if (data === undefined) return;
      const types: unknown[] = Array.isArray(node.type) ? node.type : [node.type];
      const received = numeric(data) ? (types.includes("integer") && integral(data) ? "integer" : "number")
        : isEncoded(data) ? "string" : data === null ? "null" : Array.isArray(data) ? "array" : typeof data;
      const valid = types.includes(received) || (received === "integer" && types.includes("number"));
      if (!valid) return error(node, "type-error", pointer, data, { expected: node.type, received });
    };
    k.reduce = p => leaf(p.data) ? undefined : original.reduce?.(p);
  } else if (key === "const") {
    k.validate = ({ node, data, pointer }) => same(data, node.schema.const) ? undefined
      : error(node, "const-error", pointer, data, { expected: node.schema.const });
  } else if (key === "enum") {
    k.validate = ({ node, data, pointer }) => node.enum?.some(v => same(data, v)) ? undefined
      : error(node, "enum-error", pointer, data, { values: node.enum });
  } else if (key === "uniqueItems") {
    k.validate = ({ node, data, pointer }) => {
      if (!Array.isArray(data) || node.schema.uniqueItems !== true) return;
      for (let a = 0; a < data.length; a++) for (let b = 0; b < a; b++) {
        if (same(data[a], data[b])) return error(node, "unique-items-error", `${pointer}/${a}`, data[a], { duplicatePointer: `${pointer}/${b}` });
      }
    };
  } else if (key === "pattern" || key === "format") {
    k.validate = p => {
      if (!isEncoded(p.data)) return original.validate!(p);
      // A format that asserts nothing needs no characters.
      if (key === "format" && p.node.context.formats[p.node.schema.format as string] === undefined) return undefined;
      return original.validate!({ ...p, data: text(p.data) });
    };
  } else if (key === "contains") {
    k.parse = node => {
      const parsed = original.parse?.(node);
      if (parsed !== undefined && (!Array.isArray(parsed) || parsed.length > 0)) return parsed;
      for (const name of ["minContains", "maxContains"]) if (Object.hasOwn(node.schema, name)) {
        const bound: unknown = node.schema[name];
        if (!numeric(bound) || !integral(bound) || compare(bound, 0) < 0) return error(node, "schema-error", `${node.schemaLocation}/${name}`, bound, { message: `Invalid ${name}` });
      }
      return parsed;
    };
    k.validate = p => {
      const schema = { ...p.node.schema };
      for (const name of ["minContains", "maxContains"]) if (Object.hasOwn(schema, name)) {
        const bound = schema[name] as Numeric;
        // Private comparison view: every materializable array is shorter than
        // this sentinel. The authored schema and the diagnostic stay exact.
        schema[name] = typeof bound === "number" ? bound : Number.MAX_SAFE_INTEGER;
      }
      const result = original.validate!({ ...p, node: { ...p.node, schema } });
      if (isJsonError(result)) {
        const { delta: _privateDelta, ...details } = result.data;
        return {
          ...result, data: { ...details, schema: p.node.schema },
          message: `Array at ${p.pointer} does not satisfy contains occurrence bounds in ${show(p.node.schema)}`,
        };
      }
      return result;
    };
  }
  if (restored.has(key) && k.validate) {
    const validate = k.validate;
    k.validate = p => restore(p, validate(p));
  }
  if (objects.has(key) && k.validate) {
    const validate = k.validate;
    k.validate = p => leaf(p.data) ? undefined : validate(p);
  }
  return k;
}

/** The fixed draft: 2020-12 with leaf-aware keywords, exact numbers and
 * structured diagnostics. Formats stay annotations, as 2020-12 defaults. */
export const draft: Draft = {
  ...draft2020, formats: {}, errors: templates(),
  // 2020-12 treats the retired dependencies keyword as an annotation.
  keywords: draft2020.keywords.filter(k => k.keyword !== "dependencies").map(leafKeyword),
};

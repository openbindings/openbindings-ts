/**
 * Translates a JSON schema from OpenAPI 3.0's Draft-4 subset dialect into
 * JSON Schema 2020-12. OBI documents are required to use the 2020-12
 * dialect (spec §6.2, OBI-D-06), so 3.0 sources must be normalized at
 * synthesis time.
 *
 * Translations performed when `openapiVersion` is in the 3.0 family:
 *   - `{type: T, nullable: true}`        → `{type: [T, "null"]}`
 *   - `{type: [...], nullable: true}`    → `{type: [..., "null"]}`
 *   - `{nullable: true}` without `type`  → drop the keyword
 *   - `{minimum: N, exclusiveMinimum: true}` → `{exclusiveMinimum: N}`
 *   - `{exclusiveMinimum: false}` (or with no `minimum`) → drop the keyword
 *   - same for `maximum` / `exclusiveMaximum`
 *
 * 3.1 sources pass through unchanged (3.1 schemas are already 2020-12).
 * Unknown versions also pass through (forward-compatible).
 */
export function translateSchemaDialect(
  schema: unknown,
  openapiVersion: string,
): unknown {
  if (!isOpenAPI30(openapiVersion)) return schema;
  return translateNode(schema);
}

function isOpenAPI30(version: string): boolean {
  return version === "3.0" || version.startsWith("3.0.");
}

const SCHEMA_BEARING_MAP_KEYS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

const SCHEMA_BEARING_ARRAY_KEYS = new Set([
  "oneOf",
  "anyOf",
  "allOf",
  "prefixItems",
]);

const SCHEMA_BEARING_SINGLE_KEYS = new Set([
  "items",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
  "contains",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

// The decycled schema is a DAG with shared subtrees; memoize so translation
// preserves that sharing instead of re-expanding it combinatorially.
const translated = new WeakMap<object, unknown>();

function translateNode(node: unknown): unknown {
  if (node !== null && typeof node === "object") {
    const cached = translated.get(node as object);
    if (cached !== undefined) return cached;
    const out = translateNodeUncached(node);
    translated.set(node as object, out);
    return out;
  }
  return translateNodeUncached(node);
}

function translateNodeUncached(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(translateNode);
  }
  if (node === null || typeof node !== "object") return node;
  return translateObject(node as Record<string, unknown>);
}

function translateObject(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(input)) {
    if (k === "nullable" || k === "exclusiveMinimum" || k === "exclusiveMaximum") {
      continue;
    }
    if (SCHEMA_BEARING_MAP_KEYS.has(k)) {
      out[k] = translateSchemaMap(v);
    } else if (SCHEMA_BEARING_ARRAY_KEYS.has(k)) {
      out[k] = translateSchemaArray(v);
    } else if (SCHEMA_BEARING_SINGLE_KEYS.has(k)) {
      out[k] = translateNode(v);
    } else {
      out[k] = v;
    }
  }

  if (input.nullable === true) {
    const type = input.type;
    if (typeof type === "string") {
      out.type = [type, "null"];
    } else if (Array.isArray(type)) {
      const members = type as unknown[];
      out.type = members.includes("null") ? [...members] : [...members, "null"];
    }
  }

  if (input.exclusiveMinimum === true) {
    if (typeof input.minimum === "number") {
      out.exclusiveMinimum = input.minimum;
      delete out.minimum;
    }
  } else if (typeof input.exclusiveMinimum === "number") {
    out.exclusiveMinimum = input.exclusiveMinimum;
  }

  if (input.exclusiveMaximum === true) {
    if (typeof input.maximum === "number") {
      out.exclusiveMaximum = input.maximum;
      delete out.maximum;
    }
  } else if (typeof input.exclusiveMaximum === "number") {
    out.exclusiveMaximum = input.exclusiveMaximum;
  }

  return out;
}

function translateSchemaMap(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = translateNode(v);
  }
  return out;
}

function translateSchemaArray(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(translateNode);
}

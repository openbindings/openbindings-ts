/**
 * Translates a JSON schema from OpenAPI 3.0's Draft-4 subset dialect into
 * JSON Schema 2020-12. OBI documents are required to use the 2020-12
 * dialect (spec §6.2, OBI-D-06), so 3.0 sources must be normalized at
 * synthesis time.
 *
 * Translations performed when `openapiVersion` is in the 3.0 family:
 *   - `{minimum: N, exclusiveMinimum: true}` → `{exclusiveMinimum: N}`
 *   - `{exclusiveMinimum: false}` (or with no `minimum`) → drop the keyword
 *   - same for `maximum` / `exclusiveMaximum`
 *
 * Translations performed for EVERY version:
 *   - `{type: T, nullable: true}`        → `{type: [T, "null"]}`
 *   - `{type: [...], nullable: true}`    → `{type: [..., "null"]}`
 *   - `{nullable: true}` without `type`  → drop the keyword
 *   - `{nullable: false}`                → drop the keyword
 *
 * The nullable transform is deliberately NOT gated on 3.0 (parity with the
 * Go synthesizer, same rationale): OAS 3.1 removed the keyword, but the
 * median real-world 3.1 document still carries it — DRF hand-writes it into
 * pagination schemas and drf-spectacular forwards it verbatim even in 3.1
 * mode, so every DRF-backed 3.1 spec ships it (PokeAPI: 132 occurrences
 * across 54 of 100 operations). A 2020-12 validator ignores the unknown
 * keyword, leaving `type: string` to reject the very null the author
 * declared. The intent is unambiguous, and the schema-comparison profile
 * already normalizes nullable unconditionally.
 *
 * Other 3.1 keywords pass through unchanged (3.1 schemas are already
 * 2020-12); unknown versions get the nullable salvage only
 * (forward-compatible).
 */
export function translateSchemaDialect(
  schema: unknown,
  openapiVersion: string,
): unknown {
  return translateNode(schema, isOpenAPI30(openapiVersion));
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
// preserves that sharing instead of re-expanding it combinatorially. One
// cache per dialect mode: the same shared subtree translates differently
// under 3.0 rules than under the version-independent nullable salvage.
const translatedLegacy = new WeakMap<object, unknown>();
const translatedModern = new WeakMap<object, unknown>();

function translateNode(node: unknown, legacy: boolean): unknown {
  if (node !== null && typeof node === "object") {
    const cache = legacy ? translatedLegacy : translatedModern;
    const cached = cache.get(node);
    if (cached !== undefined) return cached;
    const out = translateNodeUncached(node, legacy);
    cache.set(node, out);
    return out;
  }
  return translateNodeUncached(node, legacy);
}

function translateNodeUncached(node: unknown, legacy: boolean): unknown {
  if (Array.isArray(node)) {
    return node.map(item => translateNode(item, legacy));
  }
  if (node === null || typeof node !== "object") return node;
  return translateObject(node as Record<string, unknown>, legacy);
}

function translateObject(
  input: Record<string, unknown>,
  legacy: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(input)) {
    // nullable never survives into the OBI in any version: translated into
    // the type union when true (below), meaningless when false.
    if (k === "nullable" || (legacy && (k === "exclusiveMinimum" || k === "exclusiveMaximum"))) {
      continue;
    }
    if (SCHEMA_BEARING_MAP_KEYS.has(k)) {
      out[k] = translateSchemaMap(v, legacy);
    } else if (SCHEMA_BEARING_ARRAY_KEYS.has(k)) {
      out[k] = translateSchemaArray(v, legacy);
    } else if (SCHEMA_BEARING_SINGLE_KEYS.has(k)) {
      out[k] = translateNode(v, legacy);
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

  if (legacy) {
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
  }

  return out;
}

function translateSchemaMap(value: unknown, legacy: boolean): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = translateNode(v, legacy);
  }
  return out;
}

function translateSchemaArray(value: unknown, legacy: boolean): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(item => translateNode(item, legacy));
}

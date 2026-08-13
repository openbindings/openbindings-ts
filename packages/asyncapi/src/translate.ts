/**
 * Rewrites an AsyncAPI Schema Object into the JSON Schema 2020-12 dialect an
 * OBI schema position requires (core OBI-D-06, OBI-D-17). Every accepted
 * AsyncAPI edition's default Schema Object is a superset of JSON Schema
 * Draft 07, so a verbatim copy is faithful only where the two dialects agree;
 * where they diverge, copying either produces an invalid OBI (tuple `items`,
 * Draft-07 `$id` forms, `$schema`) or — worse — a valid schema that silently
 * means something the author did not write (`dependencies` and
 * `additionalItems` become inert annotations; assertion keywords beside
 * `$ref` become active). The binding specification names this boundary in
 * §9.2; the mapping itself is synthesis behavior, pinned by the portable
 * conformance scenarios and mirrored exactly by the Go SDK's translate.go.
 */

const SCHEMA_BEARING_MAP_KEYS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

const SCHEMA_BEARING_ARRAY_KEYS = new Set(["oneOf", "anyOf", "allOf", "prefixItems"]);

const SCHEMA_BEARING_SINGLE_KEYS = new Set([
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
  "contains",
  "contentSchema",
  "unevaluatedItems",
  "unevaluatedProperties",
  "additionalItems",
  "items",
]);

/** Validation keywords Draft 07 ignores beside `$ref` (post-translation spellings). */
const DRAFT07_ASSERTION_KEYS = new Set([
  "type", "enum", "const",
  "multipleOf", "maximum", "exclusiveMaximum", "minimum", "exclusiveMinimum",
  "maxLength", "minLength", "pattern",
  "items", "prefixItems", "maxItems", "minItems", "uniqueItems",
  "contains", "maxContains", "minContains",
  "maxProperties", "minProperties", "required",
  "properties", "patternProperties", "additionalProperties",
  "dependentRequired", "dependentSchemas", "propertyNames",
  "if", "then", "else",
  "allOf", "anyOf", "oneOf", "not",
  "unevaluatedItems", "unevaluatedProperties",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function translateSchemaDialect(schema: Record<string, unknown>): Record<string, unknown> {
  return translateObject(schema);
}

function translateNode(node: unknown): unknown {
  if (isObject(node)) return translateObject(node);
  return node;
}

function translateObject(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (key === "$schema") continue;

    if (key === "$id") {
      if (typeof value !== "string") continue;
      if (isAbsoluteURI(value)) {
        out["$id"] = value;
      } else {
        const anchor = plainNameFragmentAnchor(value);
        if (anchor !== undefined && !Object.hasOwn(input, "$anchor")) out["$anchor"] = anchor;
      }
      // Other non-absolute forms drop; dependent refs dangle loudly.
      continue;
    }

    if (key === "dependencies") {
      if (!isObject(value)) continue;
      const required: Record<string, unknown> = {};
      const schemas: Record<string, unknown> = {};
      for (const [name, dep] of Object.entries(value)) {
        if (Array.isArray(dep)) required[name] = dep;
        else schemas[name] = translateNode(dep);
      }
      mergeAbsent(out, input, "dependentRequired", required);
      mergeAbsent(out, input, "dependentSchemas", schemas);
      continue;
    }

    if (key === "prefixItems") {
      // Draft 07 does not define prefixItems, so the author's dialect
      // ignored it. Carrying an empty array into 2020-12 would turn an
      // inert annotation into an ill-formed keyword (2020-12 requires a
      // non-empty array); dropping preserves the declared semantics
      // exactly. Non-empty arrays carry through with members translated.
      if (!Array.isArray(value) || value.length === 0) continue;
      out[key] = value.map(translateNode);
      continue;
    }

    if (key === "items") {
      if (Array.isArray(value)) {
        const authored = input["prefixItems"];
        if (!Array.isArray(authored) || authored.length === 0) {
          out["prefixItems"] = value.map(translateNode);
        }
        const rest = input["additionalItems"];
        if (rest !== undefined && !isObject(input["items"])) {
          out["items"] = translateNode(rest);
        }
        continue;
      }
      out["items"] = translateNode(value);
      continue;
    }

    if (key === "additionalItems") {
      // Meaningful only with a tuple (handled above); inert otherwise in
      // Draft 07, so dropping preserves meaning.
      continue;
    }

    if (SCHEMA_BEARING_MAP_KEYS.has(key)) {
      if (!isObject(value)) {
        out[key] = value;
        continue;
      }
      const translated: Record<string, unknown> = {};
      for (const [name, member] of Object.entries(value)) translated[name] = translateNode(member);
      out[key] = translated;
      continue;
    }

    if (SCHEMA_BEARING_ARRAY_KEYS.has(key)) {
      out[key] = Array.isArray(value) ? value.map(translateNode) : value;
      continue;
    }

    if (SCHEMA_BEARING_SINGLE_KEYS.has(key)) {
      out[key] = translateNode(value);
      continue;
    }

    out[key] = value;
  }

  // Draft 07: a schema containing $ref ignores assertion siblings; keeping
  // them in 2020-12 would activate constraints the author's dialect made
  // inert. Annotations and unknown keywords stay.
  if (typeof out["$ref"] === "string") {
    for (const key of Object.keys(out)) {
      if (key !== "$ref" && DRAFT07_ASSERTION_KEYS.has(key)) delete out[key];
    }
  }

  return out;
}

function mergeAbsent(
  out: Record<string, unknown>,
  input: Record<string, unknown>,
  key: string,
  members: Record<string, unknown>,
): void {
  if (Object.keys(members).length === 0) return;
  const existing = input[key];
  if (isObject(existing)) {
    const merged: Record<string, unknown> = { ...members };
    for (const [name, member] of Object.entries(existing)) merged[name] = translateNode(member);
    out[key] = merged;
    return;
  }
  out[key] = members;
}

function isAbsoluteURI(text: string): boolean {
  const colon = text.indexOf(":");
  if (colon <= 0) return false;
  const scheme = text.slice(0, colon);
  if (!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme)) return false;
  return !text.includes("#");
}

/** Recognizes Draft 07's `$id: "#name"` form, which 2020-12 split into `$anchor`. */
function plainNameFragmentAnchor(text: string): string | undefined {
  if (!text.startsWith("#") || text.length < 2) return undefined;
  const name = text.slice(1);
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) ? name : undefined;
}

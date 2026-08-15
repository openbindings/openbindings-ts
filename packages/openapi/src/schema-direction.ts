import type { DeclaredComponent } from "./util.js";

/** Which OpenAPI data direction a synthesized operation boundary represents. */
export type OpenAPISchemaDirection = "request" | "response";

export interface OpenAPISchemaProjector {
  /** Projects one schema root without treating the root itself as a property. */
  project(schema: unknown): unknown;
  /** Component names transferred from dereferenced source nodes to projected clones. */
  readonly componentNames: ReadonlyMap<object, DeclaredComponent>;
}

const SCHEMA_MAP_KEYS = new Set([
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

const SCHEMA_ARRAY_KEYS = new Set([
  "oneOf",
  "anyOf",
  "allOf",
  "prefixItems",
]);

const SCHEMA_SINGLE_KEYS = new Set([
  "items",
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
]);

/**
 * Creates a direction-specific projector for fully dereferenced OpenAPI
 * schemas. Request projection omits `readOnly: true` properties; response
 * projection omits `writeOnly: true` properties. Required lists are repaired
 * at the schema that owns them, including declarations reached through
 * `allOf`. Other schema constraints and annotations remain intact.
 *
 * One projector is intentionally reusable across all schemas for one
 * operation boundary. Its identity memo preserves shared/cyclic dereferenced
 * graphs, and `componentNames` transfers names to projected clones so the
 * existing decycler can emit stable `$defs` references afterward.
 */
export function createOpenAPISchemaProjector(
  direction: OpenAPISchemaDirection,
  sourceComponentNames: ReadonlyMap<object, DeclaredComponent> = new Map(),
): OpenAPISchemaProjector {
  const memo = new WeakMap<object, unknown>();
  const componentNames = new Map<object, DeclaredComponent>();
  const omittedMemo = new WeakMap<object, ReadonlySet<string>>();

  const excludedProperty = (schema: unknown): boolean => {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
    const record = schema as Record<string, unknown>;
    return direction === "request" ? record.readOnly === true : record.writeOnly === true;
  };

  const omittedProperties = (schema: Record<string, unknown>): ReadonlySet<string> => {
    const cached = omittedMemo.get(schema);
    if (cached) return cached;
    const omitted = new Set<string>();
    omittedMemo.set(schema, omitted);

    const properties = schema.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      for (const [name, propertySchema] of Object.entries(properties as Record<string, unknown>)) {
        if (excludedProperty(propertySchema)) omitted.add(name);
      }
    }
    // `allOf` schemas jointly describe one instance. A directional annotation
    // in any member therefore removes that property from this boundary, even
    // when a parent-level required list names the member-declared property.
    if (Array.isArray(schema.allOf)) {
      for (const member of schema.allOf) {
        if (!member || typeof member !== "object" || Array.isArray(member)) continue;
        for (const name of omittedProperties(member as Record<string, unknown>)) omitted.add(name);
      }
    }
    return omitted;
  };

  const project = (node: unknown): unknown => {
    if (node === null || typeof node !== "object") return node;
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      memo.set(node, out);
      for (const item of node) out.push(project(item));
      return out;
    }

    const input = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    memo.set(node, out);
    const componentName = sourceComponentNames.get(node);
    if (componentName !== undefined) componentNames.set(out, componentName);

    const omitted = omittedProperties(input);
    for (const [key, value] of Object.entries(input)) {
      if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
        const projected: Record<string, unknown> = {};
        for (const [name, propertySchema] of Object.entries(value as Record<string, unknown>)) {
          if (omitted.has(name)) continue;
          projected[name] = project(propertySchema);
        }
        out.properties = projected;
      } else if (key === "required" && Array.isArray(value)) {
        const required = value.filter(
          (name): name is string => typeof name === "string" && !omitted.has(name),
        );
        if (required.length > 0) out.required = required;
      } else if (SCHEMA_MAP_KEYS.has(key)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          out[key] = value;
        } else {
          const projected: Record<string, unknown> = {};
          for (const [name, schema] of Object.entries(value as Record<string, unknown>)) {
            projected[name] = project(schema);
          }
          out[key] = projected;
        }
      } else if (SCHEMA_ARRAY_KEYS.has(key)) {
        out[key] = Array.isArray(value) ? value.map(project) : value;
      } else if (SCHEMA_SINGLE_KEYS.has(key)) {
        out[key] = project(value);
      } else {
        out[key] = value;
      }
    }
    return out;
  };

  return { project, componentNames };
}

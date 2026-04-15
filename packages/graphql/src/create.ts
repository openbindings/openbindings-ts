import type { OBInterface, Operation, JSONSchema } from "@openbindings/sdk";
import { MAX_TESTED_VERSION } from "@openbindings/sdk";
import type { IntrospectionSchema, TypeRef, TypeMap, InputValue } from "./introspection.js";
import { buildTypeMap, rootTypeName, unwrapTypeName } from "./introspection.js";
import { FORMAT_TOKEN, DEFAULT_SOURCE_NAME, QUERY_FIELD_NAME } from "./constants.js";
import { buildQueryFromIntrospection } from "./execute.js";

/** Convert a GraphQL introspection schema to an OBInterface. */
export function convertToInterface(schema: IntrospectionSchema, location?: string): OBInterface {
  const source: { format: string; location?: string } = { format: FORMAT_TOKEN };
  if (location) source.location = location;

  const operations: Record<string, Operation> = {};
  const bindings: Record<string, { operation: string; source: string; ref: string }> = {};
  const usedKeys = new Map<string, string>();
  const tm = buildTypeMap(schema);

  const rootTypes: Array<{ label: string; typeName: string | null }> = [
    { label: "Query", typeName: rootTypeName(schema, "Query") },
    { label: "Mutation", typeName: rootTypeName(schema, "Mutation") },
    { label: "Subscription", typeName: rootTypeName(schema, "Subscription") },
  ];

  for (const rt of rootTypes) {
    if (!rt.typeName) continue;
    const t = tm.get(rt.typeName);
    if (!t?.fields) continue;

    const fields = [...t.fields].sort((a, b) => a.name.localeCompare(b.name));

    for (const f of fields) {
      if (f.name.startsWith("__")) continue;

      const ref = `${rt.label}/${f.name}`;
      const opKey = resolveKey(sanitizeKey(f.name), rt.label.toLowerCase(), usedKeys);
      usedKeys.set(opKey, ref);

      const op: Operation = {};
      if (f.description) op.description = f.description;
      if (f.isDeprecated) op.deprecated = true;

      // Build the full query at creation time.
      const { query: queryStr } = buildQueryFromIntrospection(schema, rt.label, f.name, null);

      // Build input schema with _query const.
      op.input = argsToInputSchemaWithQuery(f.args, tm, queryStr);

      // Build output schema.
      const returnType = unwrapTypeName(f.type);
      if (returnType) {
        op.output = graphqlTypeToJSONSchema(f.type, tm, new Set()) as JSONSchema;
      }

      operations[opKey] = op;
      bindings[`${opKey}.${DEFAULT_SOURCE_NAME}`] = { operation: opKey, source: DEFAULT_SOURCE_NAME, ref };
    }
  }

  return {
    openbindings: MAX_TESTED_VERSION,
    operations,
    sources: { [DEFAULT_SOURCE_NAME]: source },
    bindings,
  };
}

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

function argsToInputSchemaWithQuery(
  args: InputValue[],
  tm: TypeMap,
  queryStr: string,
): Record<string, unknown> {
  const schema = argsToInputSchema(args, tm);
  if (!queryStr) return schema;
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  props[QUERY_FIELD_NAME] = { type: "string", const: queryStr };
  schema.properties = props;
  return schema;
}

function argsToInputSchema(args: InputValue[], tm: TypeMap): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const arg of args) {
    const isRequired = arg.type.kind === "NON_NULL";
    const argType = isRequired && arg.type.ofType ? arg.type.ofType : arg.type;

    const prop = graphqlTypeToJSONSchema(argType, tm, new Set());
    if (arg.description) (prop as Record<string, unknown>).description = arg.description;
    properties[arg.name] = prop;
    if (isRequired) required.push(arg.name);
  }

  const schema: Record<string, unknown> = { type: "object", properties };
  if (required.length > 0) schema.required = required.sort();
  return schema;
}

// ---------------------------------------------------------------------------
// Type conversion
// ---------------------------------------------------------------------------

function graphqlTypeToJSONSchema(t: TypeRef, tm: TypeMap, visited: Set<string>): Record<string, unknown> {
  switch (t.kind) {
    case "NON_NULL":
      return t.ofType ? graphqlTypeToJSONSchema(t.ofType, tm, visited) : { type: "string" };

    case "LIST":
      return {
        type: "array",
        items: t.ofType ? graphqlTypeToJSONSchema(t.ofType, tm, visited) : {},
      };

    case "SCALAR":
      return scalarToJSONSchema(t.name ?? "String");

    case "ENUM": {
      const ft = t.name ? tm.get(t.name) : undefined;
      if (ft?.enumValues?.length) {
        return { type: "string", enum: ft.enumValues.map((v) => v.name) };
      }
      return { type: "string" };
    }

    case "INPUT_OBJECT":
      return inputObjectToJSONSchema(t.name!, tm, visited);

    case "OBJECT":
      return objectToJSONSchema(t.name!, tm, visited);

    case "INTERFACE":
    case "UNION":
      return unionToJSONSchema(t.name!, tm, visited);

    default: {
      if (t.name) {
        const ft = tm.get(t.name);
        if (ft) return graphqlTypeToJSONSchema({ kind: ft.kind, name: ft.name, ofType: null }, tm, visited);
      }
      return { type: "string" };
    }
  }
}

function scalarToJSONSchema(name: string): Record<string, unknown> {
  switch (name) {
    case "String": case "ID": return { type: "string" };
    case "Int": return { type: "integer" };
    case "Float": return { type: "number" };
    case "Boolean": return { type: "boolean" };
    default: return { type: "string" };
  }
}

function objectToJSONSchema(name: string, tm: TypeMap, visited: Set<string>): Record<string, unknown> {
  if (visited.has(name)) return { type: "object" };
  visited.add(name);
  const ft = tm.get(name);
  if (!ft?.fields?.length) return { type: "object" };
  const properties: Record<string, unknown> = {};
  for (const f of ft.fields) {
    if (!f.name.startsWith("__")) {
      properties[f.name] = graphqlTypeToJSONSchema(f.type, tm, visited);
    }
  }
  return Object.keys(properties).length ? { type: "object", properties } : { type: "object" };
}

function inputObjectToJSONSchema(name: string, tm: TypeMap, visited: Set<string>): Record<string, unknown> {
  if (visited.has(name)) return { type: "object" };
  visited.add(name);
  const ft = tm.get(name);
  if (!ft?.inputFields?.length) return { type: "object" };
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of ft.inputFields) {
    const isRequired = f.type.kind === "NON_NULL";
    const argType = isRequired && f.type.ofType ? f.type.ofType : f.type;
    properties[f.name] = graphqlTypeToJSONSchema(argType, tm, visited);
    if (isRequired) required.push(f.name);
  }
  const schema: Record<string, unknown> = { type: "object", properties };
  if (required.length > 0) schema.required = required.sort();
  return schema;
}

function unionToJSONSchema(name: string, tm: TypeMap, visited: Set<string>): Record<string, unknown> {
  const ft = tm.get(name);
  if (!ft?.possibleTypes?.length) return { type: "object" };
  const oneOf = ft.possibleTypes
    .filter((pt) => pt.name)
    .map((pt) => graphqlTypeToJSONSchema({ kind: "OBJECT", name: pt.name, ofType: null }, tm, visited));
  return { oneOf };
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

function sanitizeKey(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+|_+$/g, "") || "unnamed";
}

function resolveKey(key: string, entityType: string, used: Map<string, string>): string {
  if (!used.has(key)) return key;
  const prefixed = `${entityType}_${key}`;
  if (!used.has(prefixed)) return prefixed;
  for (let i = 2; ; i++) {
    const numbered = `${prefixed}_${i}`;
    if (!used.has(numbered)) return numbered;
  }
}

import type { OBInterface, Operation } from "@openbindings/sdk";
import { MAX_TESTED_VERSION } from "@openbindings/sdk";
import type { FullType, IntrospectionSchema, TypeRef } from "./introspection.js";
import { buildTypeMap, rootTypeName } from "./introspection.js";
import { BINDING_SPEC, DEFAULT_SOURCE_NAME } from "./constants.js";

/** Convert a GraphQL introspection schema to an OBInterface. */
export function convertToInterface(
  schema: IntrospectionSchema,
  location?: string,
  bindingSpec = BINDING_SPEC,
): OBInterface {
  const source: { bindingSpec: string; location?: string } = { bindingSpec };
  if (location) source.location = location;

  const operations: Record<string, Operation> = {};
  const bindings: Record<string, { operation: string; source: string; ref: string }> = {};
  const usedKeys = new Map<string, string>();
  const tm = buildTypeMap(schema);

  const rootTypes: Array<{ label: string; typeName: string | null }> = [
    { label: "query", typeName: rootTypeName(schema, "query") },
    { label: "mutation", typeName: rootTypeName(schema, "mutation") },
  ];

  for (const rt of rootTypes) {
    if (!rt.typeName) continue;
    const t = tm.get(rt.typeName);
    if (!t?.fields) continue;

    const fields = [...t.fields].sort((a, b) => codePointCompare(a.name, b.name));

    for (const f of fields) {
      if (f.name.startsWith("__")) continue;

      const ref = `${rt.label}/${f.name}`;
      const opKey = resolveKey(sanitizeKey(f.name), rt.label.toLowerCase(), usedKeys);
      usedKeys.set(opKey, ref);

      const op: Operation = {};
      if (f.description) op.description = f.description;
      if (f.isDeprecated) op.deprecated = true;

      op.input = { type: "object" };
      op.output = graphQLValueSchema(f.type, tm);

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

function graphQLValueSchema(ref: TypeRef, tm: Map<string, FullType>): Record<string, unknown> {
  if (ref.kind === "NON_NULL" && ref.ofType) return graphQLNonNullSchema(ref.ofType, tm);
  const base = graphQLNonNullSchema(ref, tm);
  if (Object.keys(base).length === 0) return base;
  return { anyOf: [base, { type: "null" }] };
}

function graphQLNonNullSchema(ref: TypeRef, tm: Map<string, FullType>): Record<string, unknown> {
  switch (ref.kind) {
    case "LIST":
      return ref.ofType
        ? { type: "array", items: graphQLValueSchema(ref.ofType, tm) }
        : { type: "array" };
    case "SCALAR":
      switch (ref.name) {
        case "String":
        case "ID": return { type: "string" };
        case "Boolean": return { type: "boolean" };
        case "Int": return { type: "integer" };
        case "Float": return { type: "number" };
        default: return {};
      }
    case "ENUM": {
      const values = tm.get(ref.name ?? "")?.enumValues?.map((value) => value.name) ?? [];
      return values.length > 0 ? { type: "string", enum: values } : { type: "string" };
    }
    case "OBJECT":
    case "INTERFACE":
    case "UNION":
      return { type: "object" };
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

/** Exported for reuse by GraphQLSynthesizer.inspectSource, so an inspection
 * previews exactly what synthesis would name (Go parity: list_refs.go
 * reuses the same collision-resolution helpers SynthesizeInterface uses). */
export function sanitizeKey(name: string): string {
  // The u flag makes the class match whole code points, so an astral-plane
  // character replaces as one underscore, not one per surrogate half
  // (Go parity: SanitizeKey's regexp operates on runes).
  const key = name.replace(/[^a-zA-Z0-9._-]/gu, "_").replace(/^_+|_+$/g, "");
  if (!key) return "unnamed";
  // OBI-D-03 requires the first character to be a letter or underscore
  // (Go parity: SanitizeKey).
  return /^[A-Za-z_]/.test(key) ? key : `_${key}`;
}

/**
 * Compares strings by Unicode code point: the canonical ordering for
 * synthesis and inspection (Go parity: Go compares strings byte-wise, and
 * UTF-8 byte order is code point order). Neither `localeCompare` (collates
 * under the host locale, so output varies machine to machine) nor default
 * sort / UTF-16 code-unit `<` (ranks astral-plane code points below
 * U+E000..U+FFFF) matches the reference implementation. The order is
 * load-bearing beyond emission: it decides which of two colliding names
 * wins the bare key in {@link resolveKey}.
 */
export function codePointCompare(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length) {
    const ca = a.codePointAt(i) as number; // i < a.length, so defined
    const cb = b.codePointAt(i) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

export function resolveKey(key: string, entityType: string, used: Map<string, string>): string {
  if (!used.has(key)) return key;
  const prefixed = `${entityType}_${key}`;
  if (!used.has(prefixed)) return prefixed;
  for (let i = 2; ; i++) {
    const numbered = `${prefixed}_${i}`;
    if (!used.has(numbered)) return numbered;
  }
}

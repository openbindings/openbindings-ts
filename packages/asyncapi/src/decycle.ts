import type { AsyncAPIDocument } from "./asyncapi-types.js";
import { classifySchemaFormat } from "./synthesize.js";
import { translateSchemaDialect } from "./translate.js";

// Cyclic-reference hoisting (the openapi family's rev-2a precedent, applied
// to AsyncAPI; Go twin: decycle.go). Dereferencing inlines every acyclic
// internal reference; a cycle necessarily leaves a `{"$ref": "#/..."}` node
// behind, which would dangle in the emitted OBI (OBI-D-16). This pass
// materializes each surviving resolvable ref exactly once into the operation
// schema's `$defs` and rewrites every occurrence to point there, so the
// recursion the artifact declared survives the projection intact. A ref
// whose target does not resolve is left as-is: that is the artifact's
// dangling pointer, confined per-operation by the schema-defect gate rather
// than silently repaired.

const SCHEMA_MAP_CONTAINER_KEYS = new Set([
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
  "dependentSchemas",
]);

const LITERAL_SCHEMA_VALUE_KEYS = new Set(["const", "default", "enum", "example", "examples"]);

// ---------------------------------------------------------------------------
// Decircularization
//
// The reference pipeline terminates a cyclic internal reference by SHARING
// the object (the resolved node is its own descendant), where Go's resolver
// leaves the `$ref` string in place. Walking such a graph — translation,
// serialization, validation — would recurse forever (finding F3). This pass
// restores the Go-shaped form: every back-edge is cut by replacing the
// revisited node with a `$ref` to its canonical document pointer, after
// which the ordinary string-based hoisting above applies identically in
// both SDKs.
// ---------------------------------------------------------------------------

const registryCache = new WeakMap<object, Map<object, string>>();

/**
 * Maps every object node in the document to its canonical JSON Pointer.
 * components.schemas entries are walked first so a schema reachable both as
 * a component and inline cuts to its component name, matching the ref
 * spelling the artifact used.
 */
function docPointerRegistry(doc: AsyncAPIDocument): Map<object, string> {
  const cached = registryCache.get(doc as unknown as object);
  if (cached) return cached;
  const registry = new Map<object, string>();
  const seen = new Set<object>();
  const record = (node: unknown, pointer: string): void => {
    if (typeof node !== "object" || node === null) return;
    if (!registry.has(node)) registry.set(node, pointer);
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((member, index) => record(member, `${pointer}/${index}`));
      return;
    }
    for (const [key, member] of Object.entries(node)) {
      record(member, `${pointer}/${escapeDefsPointerSegment(key)}`);
    }
  };
  const root = doc as unknown as Record<string, unknown>;
  const components = root["components"];
  if (isObject(components) && isObject(components["schemas"])) {
    const schemas = components["schemas"];
    registry.set(schemas, "#/components/schemas");
    // Claim every entry's own name BEFORE any deep walk: dereferencing
    // shares objects, so an entry inlined into an earlier sibling would
    // otherwise be first encountered at a deep pointer and hoist under an
    // unrecognizable $defs name (Go names cuts by the artifact's own ref).
    for (const [name, entry] of Object.entries(schemas)) {
      if (typeof entry === "object" && entry !== null && !registry.has(entry)) {
        registry.set(entry, `#/components/schemas/${escapeDefsPointerSegment(name)}`);
      }
    }
    record(schemas, "#/components/schemas");
  }
  record(root, "#");
  registryCache.set(doc as unknown as object, registry);
  return registry;
}

/**
 * Returns a copy of `schema` with every back-edge (a schema object that is
 * its own ancestor in the object graph) cut into a `$ref` to the node's
 * canonical document pointer. Acyclic sharing is copied through — the same
 * expansion Go's resolver produces.
 *
 * Cut points are SCHEMA OBJECT positions only. The shared graph also aliases
 * finer-grained nodes (a `properties` map, a member array); a `$ref` at such
 * a position is not JSON Schema, so containers and literal values never cut
 * — the walk continues to the schema object where the artifact's own
 * reference necessarily sat.
 */
export function decircularizeSchema(
  schema: Record<string, unknown>,
  doc: AsyncAPIDocument,
): Record<string, unknown> {
  const registry = docPointerRegistry(doc);
  const path = new Set<object>();

  const cutSchema = (node: unknown): unknown => {
    if (typeof node !== "object" || node === null) return node;
    if (Array.isArray(node)) return node.map(cutSchema);
    if (path.has(node)) {
      const pointer = registry.get(node);
      // An unregistered back-edge has no addressable identity to preserve;
      // the unconstrained schema is the only faithful cut.
      return pointer === undefined ? {} : { $ref: pointer };
    }
    path.add(node);
    const copied: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(node)) {
      if (SCHEMA_MAP_CONTAINER_KEYS.has(key) && isObject(member)) {
        const container: Record<string, unknown> = {};
        for (const [name, entry] of Object.entries(member)) container[name] = cutSchema(entry);
        copied[key] = container;
        continue;
      }
      if (LITERAL_SCHEMA_VALUE_KEYS.has(key)) {
        copied[key] = cutLiteral(member);
        continue;
      }
      copied[key] = cutSchema(member);
    }
    path.delete(node);
    return copied;
  };

  // Literal values are data, not schemas: copied verbatim, with a guard so
  // a pathological alias back into the walked graph cannot recurse forever.
  const cutLiteral = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null) return value;
    if (path.has(value)) return Array.isArray(value) ? [] : {};
    path.add(value);
    const out = Array.isArray(value)
      ? value.map(cutLiteral)
      : Object.fromEntries(Object.entries(value).map(([key, member]) => [key, cutLiteral(member)]));
    path.delete(value);
    return out;
  };

  return cutSchema(schema) as Record<string, unknown>;
}

interface DecycleState {
  doc: AsyncAPIDocument;
  refBase: string;
  defs: Record<string, unknown>;
  names: Map<string, string>; // source ref -> assigned $defs name
  taken: Set<string>;
}

/**
 * Hoists surviving internal refs of one operation direction. refBase is the
 * emitted schema's own location, e.g. "#/operations/sendUserSignedUp/input".
 */
export function decycleOperationSchema(
  schema: Record<string, unknown>,
  doc: AsyncAPIDocument,
  refBase: string,
): Record<string, unknown> {
  // The walk rewrites in place; the boundary schema still aliases document
  // memory below the top level, so hoisting always works on its own copy.
  const copied = deepCopy(schema) as Record<string, unknown>;
  const state: DecycleState = { doc, refBase, defs: {}, names: new Map(), taken: new Set() };
  // Seed name uniquification with the schema's own $defs members so a
  // hoisted component never shadows an artifact-authored definition.
  const existing = copied["$defs"];
  if (isObject(existing)) for (const name of Object.keys(existing)) state.taken.add(name);
  const result = decycleNode(copied, state) as Record<string, unknown>;
  if (Object.keys(state.defs).length > 0) {
    const merged: Record<string, unknown> = {};
    const own = result["$defs"];
    if (isObject(own)) for (const [name, member] of Object.entries(own)) merged[name] = member;
    for (const [name, member] of Object.entries(state.defs)) merged[name] = member;
    result["$defs"] = merged;
  }
  return result;
}

function decycleNode(node: unknown, state: DecycleState): unknown {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) node[i] = decycleNode(node[i], state);
    return node;
  }
  if (!isObject(node)) return node;
  const ref = node["$ref"];
  if (typeof ref === "string" && ref.startsWith("#/")) {
    // A derivation-emitted local ref ("#/$defs/<name>", the Avro
    // correspondence's named-type spelling) rebases onto the operation
    // schema's own pointer; artifact refs materialize as before. The walk
    // then continues into sibling members: 2020-12 evaluates keywords
    // beside $ref, and the derived root is exactly {$ref, $defs} —
    // returning here would leave every ref inside that $defs unrebased
    // (dangling in the emitted document).
    if (ref.startsWith("#/$defs/")) {
      node["$ref"] = state.refBase + ref.slice(1);
    } else {
      const name = materialize(ref, state);
      if (name !== undefined) {
        node["$ref"] = `${state.refBase}/$defs/${escapeDefsPointerSegment(name)}`;
      }
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (SCHEMA_MAP_CONTAINER_KEYS.has(key) && isObject(value)) {
      for (const [name, member] of Object.entries(value)) {
        value[name] = decycleNode(member, state);
      }
      continue;
    }
    if (LITERAL_SCHEMA_VALUE_KEYS.has(key) || key.toLowerCase().startsWith("x-")) continue;
    node[key] = decycleNode(value, state);
  }
  return node;
}

/**
 * Resolves ref from the (already dereferenced) document into $defs, once,
 * applying the same dialect pipeline the payload itself went through, and
 * returns the assigned name. A target that does not resolve to a schema
 * object reports undefined and the caller leaves the artifact's dangling
 * ref untouched.
 */
function materialize(ref: string, state: DecycleState): string | undefined {
  const assigned = state.names.get(ref);
  if (assigned !== undefined) return assigned;
  const target = resolvePointer(state.doc as unknown as Record<string, unknown>, ref);
  if (!isObject(target)) return undefined;
  const name = uniqueDefName(defsNameForRef(ref), state);
  state.names.set(ref, name);
  state.defs[name] = null; // reserve before expansion: terminates self-reference

  // The target still lives in the shared object graph: cut its own
  // back-edges first (a cyclic target necessarily contains one), which also
  // yields the private copy the rewrite below needs.
  let copied = decircularizeSchema(target, state.doc);
  // components.schemas entries in a v3 document may be Multi Format Schema
  // Objects; the wrapper is never schema vocabulary.
  let format = "";
  const declared = copied["schemaFormat"];
  if (typeof declared === "string") {
    const inner = copied["schema"];
    copied = isObject(inner) ? inner : {};
    format = declared;
  }
  switch (classifySchemaFormat(format || undefined)) {
    case "foreign":
      // The direction-level rule (§9.2): a foreign representation enters an
      // OBI schema position only as the unconstrained schema.
      state.defs[name] = {};
      return name;
    case "translate":
      copied = translateSchemaDialect(copied);
      break;
    default:
      break;
  }
  state.defs[name] = decycleNode(copied, state);
  return name;
}

function uniqueDefName(base: string, state: DecycleState): string {
  const stem = base === "" ? "schema" : base;
  let name = stem;
  for (let suffix = 2; state.taken.has(name) || Object.hasOwn(state.defs, name); suffix += 1) {
    name = `${stem}_${suffix}`;
  }
  state.taken.add(name);
  return name;
}

/** Derives a readable $defs key: the trailing pointer segment, unescaped. */
function defsNameForRef(ref: string): string {
  const i = ref.lastIndexOf("/");
  const segment = i >= 0 ? ref.slice(i + 1) : ref;
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function escapeDefsPointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function resolvePointer(root: Record<string, unknown>, ref: string): unknown {
  const segments = ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else if (isObject(current)) {
      if (!Object.hasOwn(current, segment)) return undefined;
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function deepCopy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepCopy);
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) out[key] = deepCopy(member);
    return out;
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

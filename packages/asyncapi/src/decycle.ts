import { deepCopyObject, isRawObject, resolveRawJSONPointer, resolveSchemaRefs, type RawObject } from "./resolve-refs.js";
import { classifySchemaFormat } from "./synthesize.js";
import { translateSchemaDialect } from "./translate.js";

// Cyclic-reference hoisting (the openapi family's rev-2a precedent, applied
// to AsyncAPI; Go twin: decycle.go). The raw-lane resolver
// (resolve-refs.ts) inlines every acyclic internal reference; a cycle
// necessarily leaves a `{"$ref": "#/..."}` node behind, which would dangle
// in the emitted OBI (OBI-D-16). This pass materializes each surviving
// resolvable ref exactly once into the operation schema's `$defs` — under
// the artifact's own trailing ref segment, so cut names are
// artifact-derived by construction — and rewrites every occurrence to point
// there, so the recursion the artifact declared survives the projection
// intact. A ref whose target does not resolve is left as-is: that is the
// artifact's dangling pointer, confined per-operation by the schema-defect
// gate rather than silently repaired.

const SCHEMA_MAP_CONTAINER_KEYS = new Set([
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
  "dependentSchemas",
]);

const LITERAL_SCHEMA_VALUE_KEYS = new Set(["const", "default", "enum", "example", "examples"]);

interface DecycleState {
  raw: RawObject;
  refBase: string;
  defs: Record<string, unknown>;
  names: Map<string, string>; // source ref -> assigned $defs name
  taken: Set<string>;
}

/**
 * Hoists surviving internal refs of one operation direction. rawDoc is the
 * boundary document's raw snapshot (the pointer-lookup base, Go twin:
 * doc.raw); refBase is the emitted schema's own location, e.g.
 * "#/operations/sendUserSignedUp/input".
 */
export function decycleOperationSchema(
  schema: Record<string, unknown>,
  rawDoc: RawObject,
  refBase: string,
): Record<string, unknown> {
  // The walk rewrites in place; the boundary schema may still alias document
  // memory below the top level, so hoisting always works on its own copy.
  const copied = deepCopy(schema) as Record<string, unknown>;
  const state: DecycleState = { raw: rawDoc, refBase, defs: {}, names: new Map(), taken: new Set() };
  // Seed name uniquification with the schema's own $defs members so a
  // hoisted component never shadows an artifact-authored definition.
  const existing = copied["$defs"];
  if (isObject(existing)) for (const name of Object.keys(existing)) state.taken.add(name);
  const result = decycleNode(copied, state, "", state.refBase) as Record<string, unknown>;
  if (Object.keys(state.defs).length > 0) {
    const merged: Record<string, unknown> = {};
    const own = result["$defs"];
    if (isObject(own)) for (const [name, member] of Object.entries(own)) merged[name] = member;
    for (const [name, member] of Object.entries(state.defs)) merged[name] = member;
    result["$defs"] = merged;
  }
  return result;
}

/**
 * Walks one node. path is the node's JSON Pointer below the operation
 * direction (refBase); anchor is the absolute pointer of the nearest
 * ancestor (or self) carrying a $defs map — the base a derivation-emitted
 * "#/$defs/<name>" ref is relative to. A derived schema rides inside the
 * routed envelope at properties.payload (or .headers), so its
 * self-relative refs must rebase onto ITS location, not the direction
 * root. (Go twin: decycleNode.)
 */
function decycleNode(node: unknown, state: DecycleState, path: string, anchor: string): unknown {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) node[i] = decycleNode(node[i], state, `${path}/${i}`, anchor);
    return node;
  }
  if (!isObject(node)) return node;
  if (isObject(node["$defs"])) {
    anchor = state.refBase + path;
  }
  const ref = node["$ref"];
  if (typeof ref === "string" && ref.startsWith("#/")) {
    // A derivation-emitted local ref ("#/$defs/<name>", the Avro
    // correspondence's named-type spelling) rebases onto its carrying
    // schema's pointer; artifact refs materialize as before. The walk
    // then continues into sibling members: 2020-12 evaluates keywords
    // beside $ref, and the derived root is exactly {$ref, $defs} —
    // returning here would leave every ref inside that $defs unrebased
    // (dangling in the emitted document).
    if (ref.startsWith("#/$defs/")) {
      node["$ref"] = anchor + ref.slice(1);
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
        value[name] = decycleNode(member, state, `${path}/${escapeDefsPointerSegment(key)}/${escapeDefsPointerSegment(name)}`, anchor);
      }
      continue;
    }
    if (LITERAL_SCHEMA_VALUE_KEYS.has(key) || key.toLowerCase().startsWith("x-")) continue;
    node[key] = decycleNode(value, state, `${path}/${escapeDefsPointerSegment(key)}`, anchor);
  }
  return node;
}

/**
 * Resolves ref from the raw snapshot into $defs, once, applying the same
 * resolution and dialect pipeline the payload itself went through (the
 * visited set is seeded with the materialized ref, so the target's own
 * self-reference survives as the literal spelling for the recursive
 * rewrite), and returns the assigned name. A target that does not resolve
 * to a schema object reports undefined and the caller leaves the
 * artifact's dangling ref untouched. (Go twin: materialize.)
 */
function materialize(ref: string, state: DecycleState): string | undefined {
  const assigned = state.names.get(ref);
  if (assigned !== undefined) return assigned;
  const target = resolveRawJSONPointer(state.raw, ref);
  if (!isRawObject(target)) return undefined;
  const name = uniqueDefName(defsNameForRef(ref), state);
  state.names.set(ref, name);
  state.defs[name] = null; // reserve before expansion: terminates self-reference

  let copied = deepCopyObject(target);
  // components.schemas entries in a v3 document may be Multi Format Schema
  // Objects; the wrapper is never schema vocabulary.
  let format = "";
  const declared = copied["schemaFormat"];
  if (typeof declared === "string") {
    const inner = copied["schema"];
    copied = isRawObject(inner) ? inner : {};
    format = declared;
  }
  switch (classifySchemaFormat(format || undefined)) {
    case "foreign":
      // The direction-level rule (§9.2): a foreign representation enters an
      // OBI schema position only as the unconstrained schema.
      state.defs[name] = {};
      return name;
    case "translate":
      copied = translateSchemaDialect(resolveSchemaRefs(copied, state.raw, { [ref]: true }) ?? {});
      break;
    default:
      copied = resolveSchemaRefs(copied, state.raw, { [ref]: true }) ?? {};
      break;
  }
  state.defs[name] = decycleNode(copied, state, `/$defs/${escapeDefsPointerSegment(name)}`, state.refBase);
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

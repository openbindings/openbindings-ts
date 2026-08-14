import type { AsyncAPIDocument } from "./asyncapi-types.js";
import { rawParsedDocument } from "./util.js";

// The raw-lane document model (F7's cut-point-parity fix, ruled 2026-08-14):
// synthesis derives operation-boundary schemas from the RETAINED RAW artifact
// tree with a direct port of the Go SDK's reference-resolution semantics
// (resolve_refs.go): every acyclic internal reference inlines by COPY under a
// per-path string-keyed visited set, and a cycle always leaves the artifact's
// LITERAL `$ref` spelling behind. Cyclic-reference hoisting (decycle.ts) then
// materializes each surviving ref under the artifact's own component name —
// the cut points and `$defs` names are artifact-derived by construction, and
// byte-identical to the Go SDK's. The parser's shared object graph (the
// @openbindings/asyncapi-client dereferencer) remains the document every
// OTHER lane consumes; only schema derivation reads the raw lane.

export type RawObject = Record<string, unknown>;

export function isRawObject(value: unknown): value is RawObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectMap(value: unknown): RawObject | undefined {
  return isRawObject(value) ? value : undefined;
}

/**
 * One parsed document's raw-lane pair (Go twin: the `document` struct's
 * resolved fields plus its `raw` snapshot):
 *
 * - `doc` — the trait-merged raw tree with schema positions RESOLVED under
 *   the Go semantics (channel/component message payloads and headers,
 *   component schemas, channel parameters; operations-map, reply, and tag
 *   references inlined).
 * - `raw` — the trait-merged tree BEFORE schema resolution: the pointer
 *   lookup base for resolution and for decycle's `$defs` materialization
 *   (Go twin: doc.raw).
 */
export interface BoundaryDocument {
  doc: RawObject;
  raw: RawObject;
}

const boundaryByParsed = new WeakMap<object, BoundaryDocument>();

/**
 * Builds (once per parsed document) the raw-lane boundary document from the
 * artifact tree the client's parser retained. Mirrors the Go pipeline
 * exactly: trait merge on the raw envelope (the Go client's
 * NormalizeDocument), snapshot, then in-place reference resolution against
 * the snapshot (the Go SDK's resolveRefs).
 */
export function boundaryDocument(parsed: AsyncAPIDocument): BoundaryDocument {
  const cached = boundaryByParsed.get(parsed);
  if (cached) return cached;
  const retained = rawParsedDocument(parsed as unknown as Parameters<typeof rawParsedDocument>[0]);
  if (retained === undefined) {
    throw new Error(
      "asyncapi synthesis requires a document produced by parseAsyncAPIDocument (no retained raw artifact tree)",
    );
  }
  const doc = structuredClone(retained);
  applyRawDocumentTraits(doc);
  const raw = structuredClone(doc);
  resolveRawRefs(doc, raw);
  const boundary: BoundaryDocument = { doc, raw };
  boundaryByParsed.set(parsed, boundary);
  return boundary;
}

// ---------------------------------------------------------------------------
// Traits Merge Mechanism on the raw envelope (Go twin: the Go client's
// traits.go — traits apply in declaration order via JSON Merge Patch, then
// the target applies last so it always wins; trait references resolve
// against the raw root).
// ---------------------------------------------------------------------------

const UNRESOLVED_TRAIT_FIELD = "x-ob-asyncapi-unresolved-trait";

export function applyRawDocumentTraits(root: RawObject): void {
  const operations = objectMap(root["operations"]);
  if (operations) {
    for (const [name, value] of Object.entries(operations)) {
      const operation = objectMap(value);
      if (!operation) continue;
      const resolved = resolveTraitTarget(operation, root, undefined);
      if (resolved) operations[name] = applyTraits(resolved, root);
    }
  }
  visitRawMessageMap(root, root["channels"]);
  const components = objectMap(root["components"]);
  if (components) visitRawMessages(root, components["messages"]);
}

function visitRawMessageMap(root: RawObject, value: unknown): void {
  const channels = objectMap(value);
  if (!channels) return;
  for (const [name, member] of Object.entries(channels)) {
    const channel = objectMap(member);
    if (!channel) continue;
    const resolved = resolveTraitTarget(channel, root, undefined);
    if (resolved) {
      visitRawMessages(root, resolved["messages"]);
      channels[name] = resolved;
    }
  }
}

function visitRawMessages(root: RawObject, value: unknown): void {
  const messages = objectMap(value);
  if (!messages) return;
  for (const [name, member] of Object.entries(messages)) {
    const message = objectMap(member);
    if (!message) continue;
    const resolved = resolveTraitTarget(message, root, undefined);
    if (resolved) messages[name] = applyTraits(resolved, root);
  }
}

function applyTraits(target: RawObject, root: RawObject): RawObject {
  const declared = target["traits"];
  if (!Array.isArray(declared)) return target;
  let inherited: unknown = {};
  let unresolved = "";
  for (const member of declared) {
    const trait = objectMap(member);
    if (!trait) continue;
    const resolved = resolveTraitTarget(trait, root, undefined);
    if (!resolved) {
      const ref = trait["$ref"];
      if (typeof ref === "string" && unresolved === "") unresolved = ref;
      continue;
    }
    inherited = mergePatch(inherited, resolved);
  }
  const own = deepCopyObject(target);
  delete own["traits"];
  const merged = mergePatch(inherited, own) as RawObject;
  if (unresolved !== "") merged[UNRESOLVED_TRAIT_FIELD] = unresolved;
  return merged;
}

function resolveTraitTarget(
  value: RawObject,
  root: RawObject,
  visited: Set<string> | undefined,
): RawObject | undefined {
  const ref = value["$ref"];
  if (typeof ref !== "string") return deepCopyObject(value);
  visited ??= new Set<string>();
  if (visited.has(ref)) return undefined;
  visited.add(ref);
  const target = objectMap(resolveRawJSONPointer(root, ref));
  if (!target) return undefined;
  return resolveTraitTarget(target, root, visited);
}

/** RFC 7396 JSON Merge Patch over the (acyclic) raw envelope. */
function mergePatch(target: unknown, patch: unknown): unknown {
  const patchObject = objectMap(patch);
  if (!patchObject) return deepCopyValue(patch);
  const targetObject = objectMap(target);
  const result: RawObject = targetObject ? deepCopyObject(targetObject) : {};
  for (const [key, value] of Object.entries(patchObject)) {
    if (value === null) {
      delete result[key];
      continue;
    }
    result[key] = mergePatch(result[key], value);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reference resolution (Go twin: the Go SDK's resolve_refs.go — resolveRefs
// and its per-pointer resolvers). Mutates `doc` in place; every pointer
// lookup resolves against the immutable `raw` snapshot.
// ---------------------------------------------------------------------------

export function resolveRawRefs(doc: RawObject, raw: RawObject): void {
  // 0. Operations-map entries that are Reference Objects resolve through the
  // reference before the operation-object test (ASYNC-D-03). A reference
  // that does not resolve keeps its $ref — a dangling entry, refused
  // downstream.
  const operations = objectMap(doc["operations"]);
  if (operations) {
    for (const [opID, value] of Object.entries(operations)) {
      const op = objectMap(value);
      if (!op) continue;
      const ref = op["$ref"];
      if (typeof ref !== "string" || ref === "") continue;
      const resolved = resolveOperationRefByPointer(ref, raw);
      if (resolved) operations[opID] = resolved;
    }
    for (const value of Object.values(operations)) {
      const op = objectMap(value);
      if (!op) continue;
      const tags = op["tags"];
      if (!Array.isArray(tags)) continue;
      for (let index = 0; index < tags.length; index += 1) {
        const tag = objectMap(tags[index]);
        if (!tag) continue;
        const ref = tag["$ref"];
        if (typeof ref !== "string" || ref === "") continue;
        const resolved = resolveTagRefByPointer(ref, raw);
        if (resolved) tags[index] = resolved;
      }
    }
    // 0a. Reply Objects that are Reference Objects: keeping only the
    // Reference Object would be indistinguishable downstream from an
    // operation with no reply at all.
    for (const value of Object.values(operations)) {
      const op = objectMap(value);
      if (!op) continue;
      const reply = objectMap(op["reply"]);
      if (!reply) continue;
      const ref = reply["$ref"];
      if (typeof ref !== "string" || ref === "") continue;
      const resolved = resolveReplyRefByPointer(ref, raw);
      if (resolved) op["reply"] = resolved;
    }
  }

  const components = objectMap(doc["components"]);
  if (components) {
    // 1. Component schemas (they can reference each other).
    const schemas = objectMap(components["schemas"]);
    if (schemas) {
      for (const [name, schema] of Object.entries(schemas)) {
        const member = objectMap(schema);
        if (member) schemas[name] = resolveSchemaRefs(member, raw, undefined);
      }
    }

    // 2. Component message payloads and declared headers (they enter the
    // routed envelope under the same schema pipeline).
    const messages = objectMap(components["messages"]);
    if (messages) {
      for (const [name, value] of Object.entries(messages)) {
        const message = objectMap(value);
        if (!message) continue;
        const payload = objectMap(message["payload"]);
        if (payload) message["payload"] = resolveSchemaRefs(payload, raw, undefined);
        const headers = objectMap(message["headers"]);
        if (headers) message["headers"] = resolveSchemaRefs(headers, raw, undefined);
        const ref = message["$ref"];
        if (typeof ref === "string" && ref !== "") {
          const resolved = resolveMessageRefByPointer(ref, raw);
          if (resolved) messages[name] = resolved;
        }
      }
    }

    // 2a. Reusable Channel Parameter Objects.
    const parameters = objectMap(components["parameters"]);
    if (parameters) resolveParameterMap(parameters, raw);
  }

  // 3. Channel messages and parameters.
  const channels = objectMap(doc["channels"]);
  if (channels) {
    for (const value of Object.values(channels)) {
      const channel = objectMap(value);
      if (!channel) continue;
      const messages = objectMap(channel["messages"]);
      if (messages) {
        for (const [name, member] of Object.entries(messages)) {
          let message = objectMap(member);
          if (!message) continue;
          const ref = message["$ref"];
          if (typeof ref === "string" && ref !== "") {
            const resolved = resolveMessageRefByPointer(ref, raw);
            if (resolved) message = resolved;
          }
          const payload = objectMap(message["payload"]);
          if (payload) message["payload"] = resolveSchemaRefs(payload, raw, undefined);
          const headers = objectMap(message["headers"]);
          if (headers) message["headers"] = resolveSchemaRefs(headers, raw, undefined);
          messages[name] = message;
        }
      }
      const parameters = objectMap(channel["parameters"]);
      if (parameters) resolveParameterMap(parameters, raw);
    }
  }
}

function resolveParameterMap(parameters: RawObject, raw: RawObject): void {
  for (const [name, value] of Object.entries(parameters)) {
    let parameter = objectMap(value);
    if (!parameter) continue;
    const ref = parameter["$ref"];
    if (typeof ref === "string" && ref !== "") {
      const resolved = resolveParameterRefByPointer(ref, raw, undefined);
      if (resolved) parameter = resolved;
    }
    const schema = objectMap(parameter["schema"]);
    if (schema) parameter["schema"] = resolveSchemaRefs(schema, raw, undefined);
    parameters[name] = parameter;
  }
}

/**
 * Recursively replaces `{"$ref": "#/..."}` objects with COPIES of the
 * referenced content from the raw snapshot. The string-keyed visited set
 * accumulates along the current path (copied per branch), so a cycle leaves
 * the artifact's literal `$ref` in place — the surviving spelling decycle
 * materializes under the artifact's own name (Go twin: resolveSchemaRefs).
 */
export function resolveSchemaRefs(
  schema: RawObject | undefined,
  raw: RawObject,
  visited: Record<string, true> | undefined,
): RawObject | undefined {
  if (schema === undefined) return undefined;
  visited ??= {};
  // The loader's private identity tags (the x-ob-asyncapi-* minted
  // namespace) are never schema vocabulary. The Go twin deletes the one tag
  // its client mints (x-ob-asyncapi-channel-ref); this side mints several
  // more, none of which may enter an emitted schema.
  for (const key of Object.keys(schema)) {
    if (key.startsWith("x-ob-asyncapi-")) delete schema[key];
  }

  const ref = schema["$ref"];
  if (typeof ref === "string" && ref.startsWith("#/")) {
    if (visited[ref]) {
      // Circular ref: return the schema as-is (keeps the $ref string).
      return schema;
    }
    visited[ref] = true;
    const resolved = resolveRawJSONPointer(raw, ref);
    if (isRawObject(resolved)) {
      // Deep copy to avoid mutating the raw lookup snapshot.
      const copied = deepCopyObject(resolved);
      return resolveSchemaRefs(copied, raw, visited);
    }
    // If resolution fails, return the original.
    return schema;
  }

  // Keyword recognition is position-aware: inside a map-of-schemas container
  // every key is a member NAME, not a keyword, so a property literally named
  // `enum` or `const` still has its schema resolved.
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_MAP_CONTAINER_KEYS.has(key)) {
      let members = objectMap(value);
      if (members) {
        // The container itself may be a Reference Object
        // (`properties: {"$ref": ...}`).
        const memberRef = members["$ref"];
        if (typeof memberRef === "string" && memberRef.startsWith("#/") && !visited[memberRef]) {
          const childVisited: Record<string, true> = { ...visited, [memberRef]: true };
          const resolved = resolveRawJSONPointer(raw, memberRef);
          if (isRawObject(resolved)) {
            members = deepCopyObject(resolved);
            schema[key] = members;
            visited = childVisited;
          }
        }
        for (const [name, member] of Object.entries(members)) {
          const memberSchema = objectMap(member);
          if (memberSchema) members[name] = resolveSchemaRefs(memberSchema, raw, { ...visited });
        }
        continue;
      }
    }
    if (isLiteralSchemaValueKey(key) || key.toLowerCase().startsWith("x-")) continue;
    if (isRawObject(value)) {
      schema[key] = resolveSchemaRefs(value, raw, { ...visited });
    } else if (Array.isArray(value)) {
      resolveSchemaRefsInSlice(value, raw, visited);
    }
  }

  return schema;
}

/** Keywords whose map values hold schemas under arbitrary member names. */
const SCHEMA_MAP_CONTAINER_KEYS = new Set([
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
  "dependentSchemas",
]);

function isLiteralSchemaValueKey(key: string): boolean {
  switch (key) {
    case "const":
    case "default":
    case "enum":
    case "example":
    case "examples":
      return true;
    default:
      return false;
  }
}

function resolveSchemaRefsInSlice(
  values: unknown[],
  raw: RawObject,
  visited: Record<string, true>,
): void {
  for (let index = 0; index < values.length; index += 1) {
    const member = objectMap(values[index]);
    if (member) values[index] = resolveSchemaRefs(member, raw, { ...visited });
  }
}

/**
 * Resolves an RFC 6901 pointer like "#/components/schemas/Foo" against the
 * raw tree. Map-only traversal, exactly as the Go twin: a pointer stepping
 * through an ARRAY does not resolve (Go twin: resolveJSONPointer).
 */
export function resolveRawJSONPointer(root: RawObject, pointer: string): unknown {
  if (!pointer.startsWith("#/")) return undefined;
  const fragment = pointer.slice(2);
  if (fragment === "") return undefined;
  let current: unknown = root;
  for (let token of fragment.split("/")) {
    token = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isRawObject(current)) return undefined;
    current = current[token];
    if (current === null || current === undefined) return undefined;
  }
  return current;
}

// A resolved entry that is itself a Reference Object is not chased further
// (no multi-hop resolution) for operations, replies, and tags — mirroring
// the Go twin's posture. Messages copy the target unconditionally; channel
// parameters chase multi-hop.

function resolveOperationRefByPointer(ref: string, raw: RawObject): RawObject | undefined {
  if (!ref.startsWith("#/")) return undefined;
  const resolved = objectMap(resolveRawJSONPointer(raw, ref));
  if (!resolved) return undefined;
  if (typeof resolved["$ref"] === "string") return undefined;
  return deepCopyObject(resolved);
}

function resolveReplyRefByPointer(ref: string, raw: RawObject): RawObject | undefined {
  if (!ref.startsWith("#/")) return undefined;
  const resolved = objectMap(resolveRawJSONPointer(raw, ref));
  if (!resolved) return undefined;
  if (typeof resolved["$ref"] === "string") return undefined;
  return deepCopyObject(resolved);
}

function resolveMessageRefByPointer(ref: string, raw: RawObject): RawObject | undefined {
  if (!ref.startsWith("#/")) return undefined;
  const resolved = objectMap(resolveRawJSONPointer(raw, ref));
  if (!resolved) return undefined;
  return deepCopyObject(resolved);
}

function resolveParameterRefByPointer(
  ref: string,
  raw: RawObject,
  seen: Set<string> | undefined,
): RawObject | undefined {
  if (!ref.startsWith("#/")) return undefined;
  // The seen set exists only to terminate a self-referential parameter
  // chain, which would hang rather than resolve in either implementation.
  seen ??= new Set<string>();
  if (seen.has(ref)) return undefined;
  seen.add(ref);
  const resolved = objectMap(resolveRawJSONPointer(raw, ref));
  if (!resolved) return undefined;
  const copied = deepCopyObject(resolved);
  const next = copied["$ref"];
  if (typeof next === "string" && next !== "") return resolveParameterRefByPointer(next, raw, seen);
  return copied;
}

function resolveTagRefByPointer(ref: string, raw: RawObject): RawObject | undefined {
  if (!ref.startsWith("#/")) return undefined;
  const resolved = objectMap(resolveRawJSONPointer(raw, ref));
  if (!resolved) return undefined;
  if (typeof resolved["$ref"] === "string") return undefined;
  return deepCopyObject(resolved);
}

// ---------------------------------------------------------------------------
// Raw-lane navigation (Go twins: extractRefName and resolveMessageRef in the
// Go client's load.go — the forms the reference implementation recognizes).
// ---------------------------------------------------------------------------

/** The trailing pointer segment of a ref, unescaped (Go twin: extractRefName). */
export function extractRefName(ref: string): string {
  const path = ref.startsWith("#/") ? ref.slice(2) : ref;
  const parts = path.split("/");
  const last = parts[parts.length - 1] ?? "";
  return unescapeRefToken(last);
}

function unescapeRefToken(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

/**
 * Resolves an operation/reply message-list reference against the resolved
 * raw-lane document. Only the two artifact forms resolve —
 * `#/components/messages/<name>` and `#/channels/<ch>/messages/<name>` —
 * chasing message-valued `$ref` chains with a seen set (Go twin:
 * resolveMessageRef).
 */
export function resolveRawMessageRef(doc: RawObject, ref: string): RawObject | undefined {
  return resolveRawMessageRefSeen(doc, ref, new Set<string>());
}

function resolveRawMessageRefSeen(doc: RawObject, ref: string, seen: Set<string>): RawObject | undefined {
  if (ref === "") return undefined;
  if (seen.has(ref)) return undefined;
  seen.add(ref);
  const path = ref.startsWith("#/") ? ref.slice(2) : ref;
  const parts = path.split("/");
  if (parts.length === 3 && parts[0] === "components" && parts[1] === "messages") {
    const messages = objectMap(objectMap(doc["components"])?.["messages"]);
    const value = objectMap(messages?.[unescapeRefToken(parts[2] ?? "")]);
    if (value) {
      const next = value["$ref"];
      if (typeof next === "string" && next !== "") return resolveRawMessageRefSeen(doc, next, seen);
      return value;
    }
  }
  if (parts.length === 4 && parts[0] === "channels" && parts[2] === "messages") {
    const channel = objectMap(objectMap(doc["channels"])?.[unescapeRefToken(parts[1] ?? "")]);
    const value = objectMap(objectMap(channel?.["messages"])?.[unescapeRefToken(parts[3] ?? "")]);
    if (value) {
      const next = value["$ref"];
      if (typeof next === "string" && next !== "") return resolveRawMessageRefSeen(doc, next, seen);
      return value;
    }
  }
  return undefined;
}

/** The `$ref` string of a Reference Object position, or "" (Go twin: the
 *  channelRef/messageRef structs' zero value). */
export function refStringOf(value: unknown): string {
  const object = objectMap(value);
  const ref = object?.["$ref"];
  return typeof ref === "string" ? ref : "";
}

// ---------------------------------------------------------------------------
// Deep copies (Go twins: deepCopyMap / deepCopySlice).
// ---------------------------------------------------------------------------

export function deepCopyObject(value: RawObject): RawObject {
  const result: RawObject = {};
  for (const [key, member] of Object.entries(value)) result[key] = deepCopyValue(member);
  return result;
}

function deepCopyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepCopyValue);
  if (isRawObject(value)) return deepCopyObject(value);
  return value;
}

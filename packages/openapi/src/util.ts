import type { OpenAPIDocument, OpenAPIParameter } from "./types.js";
import { VALID_METHODS } from "./constants.js";
import { dereference } from "@openbindings/sdk";
import yaml from "js-yaml";
import { OpenAPIRefSiblingNormalizer } from "./ref-siblings.js";

// The u flag makes the class match whole code points, so an astral-plane
// character replaces as one underscore, not one per surrogate half
// (Go parity: SanitizeKey's regexp operates on runes).
const NON_KEY_CHARS = /[^a-zA-Z0-9._-]/gu;

/**
 * Replaces non-alphanumeric characters in a name with underscores to produce
 * a valid key. The result always matches the OBI-D-03 identifier pattern
 * ^[A-Za-z_][A-Za-z0-9_.-]*$: keys that would start with a digit, '.', or
 * '-' are prefixed with an underscore (Go parity: SanitizeKey).
 */
export function sanitizeKey(name: string): string {
  const key = name.replace(NON_KEY_CHARS, "_").replace(/^_+|_+$/g, "");
  if (!key) return "unnamed";
  return /^[A-Za-z_]/.test(key) ? key : `_${key}`;
}

/** Returns the key as-is if unused, otherwise appends a numeric suffix to make it unique. */
export function uniqueKey(key: string, used: Set<string>): string {
  if (!used.has(key)) return key;
  for (let i = 2; ; i++) {
    const candidate = `${key}_${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Compares strings by Unicode code point: the canonical ordering for
 * synthesis and inspection (Go parity: Go compares strings byte-wise, and
 * UTF-8 byte order is code point order). Neither `localeCompare` (collates
 * under the host locale, so output varies machine to machine) nor default
 * sort / UTF-16 code-unit `<` (ranks astral-plane code points below
 * U+E000..U+FFFF) matches the reference implementation. The order is
 * load-bearing beyond emission: it decides which of two colliding names
 * wins the bare key in {@link uniqueKey}.
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

/**
 * Parses a binding ref per OAPI-D-03: a JSON Pointer of the exact form
 * `#/paths/<escaped-path>/<method>` addressing an operation object. The
 * path segment carries RFC 6901 escaping ("/" → "~1", "~" → "~0"), and the
 * method is lowercase exactly as the artifact spells it — an uppercase
 * method is non-conformant and refused, never case-folded.
 */
export function parseRef(ref: string): { path: string; method: string } {
  const prefix = "#/paths/";
  if (!ref.startsWith(prefix)) {
    throw new Error(
      `ref "${ref}" must be a JSON Pointer of the form #/paths/<escaped-path>/<method> (OAPI-D-03)`,
    );
  }
  const parts = ref.slice(prefix.length).split("/");
  if (parts.length !== 2) {
    throw new Error(
      `ref "${ref}" must be a JSON Pointer of the form #/paths/<escaped-path>/<method>: the path segment carries RFC 6901 escaping ("/" → "~1") (OAPI-D-03)`,
    );
  }
  // parts.length === 2 was just checked, so both segments exist; the ""
  // fallbacks are unreachable (and "" would refuse at the method check).
  const escapedPath = parts[0] ?? "";
  const method = parts[1] ?? "";
  if (!VALID_METHODS.has(method)) {
    if (VALID_METHODS.has(method.toLowerCase())) {
      throw new Error(
        `ref "${ref}": method "${method}" must be lowercase exactly as the artifact spells it (OAPI-D-03)`,
      );
    }
    throw new Error(`invalid HTTP method "${method}" in ref`);
  }

  // RFC 6901 unescaping, in order: ~1 first, then ~0.
  const path = escapedPath.replaceAll("~1", "/").replaceAll("~0", "~");
  return { path, method };
}

/** Builds a JSON Pointer ref string from a path and HTTP method, escaping special characters. */
export function buildJsonPointerRef(path: string, method: string): string {
  const escaped = path.replaceAll("~", "~0").replaceAll("/", "~1");
  return `#/paths/${escaped}/${method.toLowerCase()}`;
}

/**
 * Loads and discriminates an OpenAPI source per openbindings.openapi@1
 * §3–§6: `content`, when present, is the artifact (content primacy), with a
 * co-present `location` serving as the embedded artifact's BASE URI —
 * relative $refs resolve against it exactly as they would had the document
 * been retrieved from that address (OAPI-D-01/D-02, §6). Embedded content
 * with no location has no base and must be self-contained: a relative
 * external $ref then fails with a readable error (absolute http(s) $refs
 * still resolve — they need no base). The artifact's own `openapi` field
 * discriminates the accepted editions (OAPI-P-01).
 *
 * String content parses as YAML 1.2 (JSON being a valid subset); duplicate
 * mapping keys are refused loudly by the YAML layer itself, satisfying the
 * §3 duplicate-key pin.
 *
 * The document is fully dereferenced before it reaches invocation or
 * synthesis logic (Go parity: the kin-openapi loader resolves every `$ref`
 * once, at load time — path items included — so downstream code always
 * sees direct values, never a `{"$ref": ...}` indirection). External refs
 * are followed via `fetchFn` (or the global `fetch`) unless
 * `options.allowExternalRefs` is explicitly `false`, which keeps the parse
 * side-effect-free (Go parity: `prepareBinding`'s content path disables
 * external I/O — "never fetches").
 */
export async function loadOpenAPIDocument(
  location?: string,
  content?: unknown,
  options?: {
    signal?: AbortSignal;
    allowExternalRefs?: boolean;
    /** Refuse schemas whose dialect cannot be projected faithfully into OBI. */
    requirePortableSchemaDialect?: boolean;
  },
  fetchFn?: typeof globalThis.fetch,
): Promise<OpenAPIDocument> {
  // `location`, when present, must be an absolute URI (OAPI-D-02) —
  // whether it is the fetch target or only the embedded content's base.
  // A bare filesystem path is refused loudly before any fetch (the Go
  // loader's posture; the former "local tooling" lenience is gone).
  if (location) validateDocumentAddress(location);
  let retrievalLocation = location;

  let raw: unknown;
  if (content !== undefined) {
    if (typeof content === "string") raw = parseJSONOrYAML(content);
    else if (typeof content === "object") raw = content;
    else raw = structuredClone(content);
  } else {
    if (!location) {
      throw new Error("source must have location or content");
    }

    const resp = await (fetchFn ?? fetch)(location, { signal: options?.signal });
    if (!resp.ok) {
      throw new Error(
        `failed to fetch ${location}: ${resp.status} ${resp.statusText}`,
      );
    }
    retrievalLocation = resp.url || location;

    let text: string;
    try {
      text = await resp.text();
    } catch (e: unknown) {
      throw new Error(
        `failed to read response body from ${location}: ${errorMessage(e)}`,
        { cause: e },
      );
    }

    try {
      raw = parseJSONOrYAML(text);
    } catch {
      const preview = text.length > 120 ? text.slice(0, 120) + "..." : text;
      throw new Error(`failed to parse response from ${location}: ${preview}`);
    }
  }

  checkAcceptedOpenAPIVersion(raw);
  const openapiVersion = (raw as Record<string, unknown>).openapi as string;
  const normalizer = new OpenAPIRefSiblingNormalizer(
    openapiVersion,
    options?.requirePortableSchemaDialect === true,
  );
  const normalized = normalizer.normalize(
    raw,
    retrievalLocation,
    location && location !== retrievalLocation ? [location] : [],
  );

  const allowExternalRefs = options?.allowExternalRefs ?? true;
  let refFetch: typeof globalThis.fetch;
  if (!allowExternalRefs) {
    refFetch = blockExternalRefFetch;
  } else if (!location && content !== undefined) {
    refFetch = selfContainedRefFetch(fetchFn ?? fetch);
  } else {
    refFetch = fetchFn ?? fetch;
  }
  refFetch = normalizeExternalRefFetch(refFetch, normalizer);
  const dereferenced = await dereference<OpenAPIDocument>(normalized as Record<string, unknown>, {
    baseUrl: retrievalLocation,
    parse: parseJSONOrYAML,
    signal: options?.signal,
    fetch: refFetch,
    mergeRefSiblings: (target, reference) => normalizer.mergeReferenceObject(target, reference),
    prepareRefTarget: (root, target) => normalizer.prepareTarget(root, target.resourceURI),
  });
  normalizer.restore(dereferenced);
  return dereferenced;
}

/**
 * Normalizes each fetched reference resource while both its requested and
 * final retrieval URI are available. The requested URI locates target-kind
 * hints recorded by the referring document; the final URI is the base for
 * nested relative references after redirects.
 */
function normalizeExternalRefFetch(
  real: typeof globalThis.fetch,
  normalizer: OpenAPIRefSiblingNormalizer,
): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const requested = input instanceof Request ? input.url : String(input);
    const response = await real(input, init);
    if (!response.ok) return response;
    const retrieval = response.url || requested;
    const parsed = parseJSONOrYAML(await response.text());
    const normalized = normalizer.normalize(
      parsed,
      retrieval,
      requested !== retrieval ? [requested] : [],
    );
    const wrapped = new Response(JSON.stringify(normalized), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    Object.defineProperty(wrapped, "url", { value: retrieval });
    return wrapped;
  };
}

/**
 * Checks OAPI-D-02's location grammar offline, without dereferencing:
 * `location`, when present, is an absolute URI addressing the OpenAPI
 * document itself. A bare filesystem path is a relative reference in form
 * (core OBI-D-05) and is refused — a local artifact is addressed as
 * file:// or embedded as the source's content.
 */
export function validateDocumentAddress(location: string): void {
  try {
    new URL(location);
  } catch {
    throw new Error(
      `openapi location ${JSON.stringify(location)} is not an absolute URI addressing the document (OAPI-D-02): a local artifact is addressed as file:// or embedded as the source's content`,
    );
  }
}

/**
 * Discriminates the exact accepted editions per OAPI-P-01. Patch-looking
 * values outside the frozen set are not inferred compatible.
 */
function checkAcceptedOpenAPIVersion(raw: unknown): void {
  const doc = raw as Record<string, unknown> | null;
  const v = doc && typeof doc === "object" ? doc["openapi"] : undefined;
  if (typeof v !== "string" || v === "") {
    throw new Error(
      "document declares no `openapi` field: openbindings.openapi@1 requires one of its exact accepted OpenAPI editions (OAPI-P-01; Swagger 2.0 is not accepted)",
    );
  }
  if (!ACCEPTED_OPENAPI_VERSIONS.has(v)) {
    throw new Error(
      `unsupported OpenAPI version "${v}": openbindings.openapi@1 accepts exactly 3.0.0–3.0.4 and 3.1.0–3.1.2 (OAPI-P-01)`,
    );
  }
}

const ACCEPTED_OPENAPI_VERSIONS = new Set([
  "3.0.0",
  "3.0.1",
  "3.0.2",
  "3.0.3",
  "3.0.4",
  "3.1.0",
  "3.1.1",
  "3.1.2",
]);

/**
 * Rejects any external `$ref` fetch. Used to keep a content-only document
 * parse side-effect-free (Go parity: `prepareBinding`'s content path never
 * touches the network — internal `#/...` refs still resolve locally).
 */
const blockExternalRefFetch: typeof globalThis.fetch = () => {
  throw new Error("external $ref resolution is disabled for this load");
};

/**
 * Allows absolute http(s) reference targets (they resolve without a base)
 * and refuses everything else: with no co-present location the embedded
 * artifact has no base URI, so a relative reference is unresolvable by
 * definition (§6 — bundle before embedding).
 */
function selfContainedRefFetch(
  real: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return real(input, init);
    }
    throw new Error(
      `reference "${url}" cannot resolve: embedded content with no co-present location has no base URI and must be self-contained (bundle the document before embedding, or set the source's location)`,
    );
  };
}

/** Merges path-level and operation-level parameters, with operation parameters taking precedence. */
export function mergeParameters(
  pathParams?: OpenAPIParameter[],
  opParams?: OpenAPIParameter[],
): OpenAPIParameter[] {
  if (!pathParams?.length) return opParams ?? [];
  if (!opParams?.length) return pathParams ?? [];
  const overridden = new Set<string>();
  for (const p of opParams) {
    if (p?.in && p?.name) overridden.add(`${p.in}:${p.name}`);
  }
  const merged = pathParams.filter(
    (p) => p?.in && p?.name && !overridden.has(`${p.in}:${p.name}`),
  );
  return [...merged, ...opParams];
}

/** Extracts a human-readable error message from an unknown thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Parses string content as YAML, of which JSON is a valid subset, so one
 * grammar covers both spellings deterministically (§3's string-grammar
 * pin). Duplicate mapping keys are refused loudly by the YAML layer itself
 * — in the JSON spelling too, which JSON.parse would silently last-wins.
 */
function parseJSONOrYAML(text: string): unknown {
  return yaml.load(text.trim());
}

/**
 * The direct-node half of §9.1's declaration-only object determination.
 * Callers recursively union `allOf` members around this predicate; a schema
 * declaring neither properties nor object type is typeless/non-object at
 * this node.
 */
export function bodySchemaFlattens(schema: Record<string, unknown>): boolean {
  const props = schema["properties"];
  const hasProperties = props != null && typeof props === "object";
  return hasProperties || isObjectTypedSchema(schema);
}

/**
 * Reports whether a body schema is explicitly object-typed (3.0 string
 * form or a single-element 3.1 type array): the object half of
 * bodySchemaFlattens' declaration facts. Mirrors the Go SDK's
 * isObjectTypedSchema (formats/openapi/synthesize.go).
 */
export function isObjectTypedSchema(schema: Record<string, unknown>): boolean {
  const ty = schema["type"];
  if (typeof ty === "string") return ty === "object";
  if (Array.isArray(ty)) return ty.length === 1 && ty[0] === "object";
  return false;
}

// ---------------------------------------------------------------------------
// Cyclic-schema handling (rev 2a)
// ---------------------------------------------------------------------------

/**
 * Maps the identity of each named component schema node to its name.
 * After full dereference, internal `$ref`s alias the very objects under
 * `components.schemas`, so object identity recovers the upstream name a
 * cycle participant was declared under.
 */
export function componentSchemaNames(doc: Record<string, unknown>): Map<object, string> {
  const names = new Map<object, string>();
  const components = doc["components"];
  const schemas = components && typeof components === "object"
    ? (components as Record<string, unknown>)["schemas"]
    : undefined;
  if (schemas && typeof schemas === "object" && !Array.isArray(schemas)) {
    for (const [name, node] of Object.entries(schemas as Record<string, unknown>)) {
      if (node && typeof node === "object") names.set(node, name);
    }
  }
  return names;
}

/**
 * Converts a possibly-cyclic dereferenced schema graph into an equivalent
 * acyclic JSON Schema tree using the dialect's own recursion mechanism:
 * every occurrence of a cycle-participating named component becomes
 * `{"$ref": "<refBase>/$defs/<componentName>"}` (a same-document pointer from the OBI root, per OBI-D-16) and the component's definition is
 * hoisted into `$defs` (itself rewritten under the same rule). An anonymous
 * cycle (one passing through no named component — only possible via a
 * non-component `$ref` target upstream) is hoisted under a deterministic
 * `cycleN` name at its back-edge target.
 *
 * This is incorporation, not invention: `$defs`/`$ref` recursion has
 * identical validation semantics to the infinite unfolding the artifact
 * declares (JSON Schema 2020-12), and the emitted OBI schema graph is
 * self-contained and fully evaluable (core §5.2 / OBI-T-16). Mirrors the Go
 * SDK's inlineRefs cyclic handling (formats/openapi/synthesize.go).
 */
/**
 * Computes, once per document, the set of named component schema nodes that
 * participate in a reference cycle (can reach themselves). decycleSchema
 * consumes this set per embedded schema.
 */
export function cyclicComponents(names: ReadonlyMap<object, string>): ReadonlySet<object> {
  const cyclic = new Set<object>();
  for (const node of names.keys()) {
    const visited = new Set<object>();
    const work: unknown[] = [node];
    let reachesSelf = false;
    while (work.length > 0 && !reachesSelf) {
      const current = work.pop();
      if (current === null || typeof current !== "object") continue;
      for (const child of Object.values(current as Record<string, unknown>)) {
        if (child === null || typeof child !== "object") continue;
        if (child === node) { reachesSelf = true; break; }
        if (!visited.has(child)) { visited.add(child); work.push(child); }
      }
    }
    if (reachesSelf) cyclic.add(node);
  }
  return cyclic;
}

/**
 * Computes the set of nodes in `root`'s object graph that can reach
 * themselves (members of a strongly connected component with a cycle).
 * Iterative Tarjan — dereferenced documents can be deep.
 */
function selfReachingSCCs(root: object): ReadonlyArray<ReadonlySet<object>> {
  const index = new Map<object, number>();
  const low = new Map<object, number>();
  const onStack = new Set<object>();
  const sccStack: object[] = [];
  const groups: Array<Set<object>> = [];
  let counter = 0;

  type Frame = { node: object; children: object[]; next: number };
  const childrenOf = (node: object): object[] => {
    const out: object[] = [];
    for (const value of Object.values(node)) {
      if (value !== null && typeof value === "object") out.push(value as object);
    }
    return out;
  };

  const frames: Frame[] = [];
  const push = (node: object): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    sccStack.push(node);
    onStack.add(node);
    frames.push({ node, children: childrenOf(node), next: 0 });
  };
  push(root);

  while (frames.length > 0) {
    const frame = frames[frames.length - 1]!;
    if (frame.next < frame.children.length) {
      const child = frame.children[frame.next]!;
      frame.next += 1;
      if (!index.has(child)) {
        push(child);
      } else if (onStack.has(child)) {
        low.set(frame.node, Math.min(low.get(frame.node) as number, index.get(child) as number));
        if (child === frame.node) groups.push(new Set([frame.node])); // self-loop
      }
    } else {
      frames.pop();
      if (low.get(frame.node) === index.get(frame.node)) {
        const members: object[] = [];
        for (;;) {
          const member = sccStack.pop() as object;
          onStack.delete(member);
          members.push(member);
          if (member === frame.node) break;
        }
        if (members.length > 1) groups.push(new Set(members));
      }
      const parent = frames[frames.length - 1];
      if (parent) {
        low.set(parent.node, Math.min(low.get(parent.node) as number, low.get(frame.node) as number));
      }
    }
  }
  return groups;
}

type SchemaPos = "schema" | "schemaMap" | "schemaArray" | "data";

const DECYCLE_SINGLE_KEYS = new Set([
  "items", "additionalProperties", "not", "if", "then", "else",
  "propertyNames", "contains", "unevaluatedItems", "unevaluatedProperties",
]);
const DECYCLE_MAP_KEYS = new Set([
  "properties", "patternProperties", "$defs", "definitions", "dependentSchemas",
]);
const DECYCLE_ARRAY_KEYS = new Set(["oneOf", "anyOf", "allOf", "prefixItems"]);

export function decycleSchema(
  schema: unknown,
  names: ReadonlyMap<object, string>,
  refBase: string,
): unknown {
  if (schema === null || typeof schema !== "object") return schema;

  // Which reachable nodes participate in a cycle? Identity-level, not
  // name-level: sibling-merged $refs produce anonymous copies whose cycles
  // never pass through the named component object, so detection is an SCC
  // computation over the object graph (iterative Tarjan). Within an SCC
  // that contains named components, only the named members are hoisted —
  // anonymous intermediates (property maps, array wrappers) inline and the
  // cycle cuts at the named node. An SCC with no named member hoists all
  // its members, cutting at the first schema-position encounter; the
  // on-stack backstop below covers any unnamed sub-loop.
  const cyclic = new Set<object>();
  for (const group of selfReachingSCCs(schema)) {
    const named = [...group].filter((member) => names.has(member));
    for (const member of named.length > 0 ? named : [...group]) cyclic.add(member);
  }

  const defs: Record<string, unknown> = {};
  const defName = new Map<object, string>();
  let anon = 0;
  const assignName = (node: object): string => {
    let name = defName.get(node);
    if (name !== undefined) return name;
    name = names.get(node) ?? `cycle${anon++}`;
    while (Object.hasOwn(defs, name) || [...defName.values()].includes(name)) name = `${name}_`;
    defName.set(node, name);
    return name;
  };
  const pendingDefs: object[] = [];
  const stack = new Set<object>();
  // Fully-dereferenced documents are DAGs: shared components appear at many
  // sites. Memoize the copy of every acyclic completed subtree (per position
  // kind) so the output shares structure instead of re-expanding it.
  const memo = new Map<SchemaPos, Map<object, unknown>>();

  const hoistRef = (node: object): Record<string, unknown> => {
    const name = assignName(node);
    if (!Object.hasOwn(defs, name)) {
      defs[name] = null; // reserve; materialized below
      pendingDefs.push(node);
    }
    return { $ref: `${refBase}/$defs/${name}` };
  };

  const childPos = (parentPos: SchemaPos, key: string): SchemaPos => {
    switch (parentPos) {
      case "schema":
        if (DECYCLE_SINGLE_KEYS.has(key)) return "schema";
        if (DECYCLE_MAP_KEYS.has(key)) return "schemaMap";
        if (DECYCLE_ARRAY_KEYS.has(key)) return "schemaArray";
        return "data"; // annotations, enum/const/default values, unknown keywords
      case "schemaMap": return "schema";
      case "schemaArray": return "schema";
      case "data": return "data";
    }
  };

  const copyChildren = (node: object, pos: SchemaPos): unknown => {
    stack.add(node);
    let out: unknown;
    if (Array.isArray(node)) {
      out = node.map((item) => copy(item, pos === "schemaArray" ? "schema" : pos === "data" ? "data" : pos));
    } else {
      const target: Record<string, unknown> = {};
      for (const key of Object.keys(node).sort(codePointCompare)) {
        target[key] = copy((node as Record<string, unknown>)[key], childPos(pos, key));
      }
      out = target;
    }
    stack.delete(node);
    return out;
  };

  const copy = (node: unknown, pos: SchemaPos): unknown => {
    if (node === null || typeof node !== "object") return node;
    const obj = node;
    // Hoisting emits a {$ref} object, which only means "reference" at a
    // schema position. Cycle participants at other positions (a shared
    // properties map behind a sibling-merged reference; annotation data)
    // are walked through — every reference cycle passes through a schema
    // position within one lap, where it is cut.
    if (pos === "schema" && !Array.isArray(obj)) {
      if (cyclic.has(obj)) return hoistRef(obj);
      if (stack.has(obj)) return hoistRef(obj); // anonymous cycle backstop
    } else if (stack.has(obj)) {
      // On-stack non-schema position: continue without re-adding; the walk
      // terminates when the cycle re-crosses a schema position.
      return copyChildrenOnStack(obj, pos);
    }
    let posMemo = memo.get(pos);
    const cached = posMemo?.get(obj);
    if (cached !== undefined) return cached;
    const out = copyChildren(obj, pos);
    if (!posMemo) { posMemo = new Map(); memo.set(pos, posMemo); }
    posMemo.set(obj, out);
    return out;
  };

  const onStackLaps = new Map<object, number>();
  const copyChildrenOnStack = (node: object, pos: SchemaPos): unknown => {
    // A cycle that never crosses a schema position (cyclic data reached via
    // a dereferenced $ref inside an annotation value) has no faithful
    // tree representation; refuse loudly rather than loop.
    const laps = (onStackLaps.get(node) ?? 0) + 1;
    if (laps > 8) {
      throw new Error("cyclic value at a non-schema position cannot be represented as a JSON tree");
    }
    onStackLaps.set(node, laps);
    try {
    if (Array.isArray(node)) {
      return node.map((item) => copy(item, pos === "schemaArray" ? "schema" : pos === "data" ? "data" : pos));
    }
    const target: Record<string, unknown> = {};
    for (const key of Object.keys(node).sort(codePointCompare)) {
      target[key] = copy((node as Record<string, unknown>)[key], childPos(pos, key));
    }
    return target;
    } finally {
      onStackLaps.set(node, (onStackLaps.get(node) ?? 1) - 1);
    }
  };

  const root = copyChildren(schema, "schema");
  while (pendingDefs.length > 0) {
    const node = pendingDefs.shift() as object;
    const name = defName.get(node) as string;
    defs[name] = copyChildren(node, "schema");
  }

  if (Object.keys(defs).length === 0) return root;
  const sortedDefs: Record<string, unknown> = {};
  for (const key of Object.keys(defs).sort(codePointCompare)) sortedDefs[key] = defs[key];
  return { ...(root as Record<string, unknown>), $defs: sortedDefs };
}


/**
 * Escapes a string for use as a JSON Pointer segment (RFC 6901).
 */
export function escapePointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * A deduplication KEY for possibly-cyclic values: JSON text with any
 * back-edge replaced by a cycle marker. Discriminating, deterministic, and
 * total on cyclic graphs — never used as an emitted value.
 */
export function cycleSafeKey(value: unknown): string {
  const stack = new Set<object>();
  const walk = (node: unknown): unknown => {
    if (node === null || typeof node !== "object") return node;
    if (stack.has(node)) return { $cycle: true };
    stack.add(node);
    let out: unknown;
    if (Array.isArray(node)) out = node.map(walk);
    else {
      const target: Record<string, unknown> = {};
      for (const key of Object.keys(node).sort(codePointCompare)) {
        target[key] = walk((node as Record<string, unknown>)[key]);
      }
      out = target;
    }
    stack.delete(node);
    return out;
  };
  return JSON.stringify(walk(value));
}

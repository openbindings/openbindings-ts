type RefSemantics = "ignore" | "compose";

const SCHEMA_MAP_KEYS = new Set([
  "properties",
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
  "additionalItems",
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

const OPERATION_KEYS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

interface ProtectedSchemaFields {
  token: string;
  values: Array<[string, unknown]>;
}

const SCHEMA_SCOPE_KEYS = ["$ref", "$id", "$anchor", "$dynamicAnchor"] as const;

type ReferencedKind = "schema" | "response" | "parameter" | "example" | "requestBody"
  | "header" | "callback" | "pathItem" | "pathItemReference" | "opaque";

interface RefTarget {
  fragment: string;
  kind: ReferencedKind;
}

interface NormalizationState {
  semantics: RefSemantics | null;
  protectedRefKey: string;
  referenceMarkerKey: string;
  referenceMarkerToken: string;
}

let protectedRefSequence = 0;

/**
 * Clones an OpenAPI artifact and exposes `$ref` only at positions where the
 * OpenAPI/JSON Schema vocabularies define reference semantics. A literal
 * `$ref` inside an example, extension, default, or other data value must stay
 * data when the generic dereferencer later walks the object graph.
 *
 * OAS 3.0 Reference Objects ignore every sibling. OAS 3.1 Schema Objects use
 * JSON Schema 2020-12 semantics, where `$ref` is an applicator and siblings
 * remain independently meaningful. The latter is represented exactly by
 * replacing `$ref` with an equivalent single-member `allOf` while leaving
 * every sibling at the same schema-resource location (important for `$id`,
 * `$anchor`, annotations, and arbitrary vocabulary keywords).
 *
 * OAS 3.1 non-schema Reference Objects are marked separately: only their
 * `summary`/`description` fields survive, and the loader later applies those
 * annotations at the reference site instead of using Schema `$ref` rules.
 */
export class OpenAPIRefSiblingNormalizer {
  private readonly targets = new Map<string, Map<string, RefTarget>>();
  private readonly protectedRefs = new Map<string, Set<string>>();
  private readonly referenceMarkers = new Map<string, Set<string>>();
  private readonly statesByProtectedToken = new Map<string, NormalizationState>();
  private readonly statesByResourceRoot = new WeakMap<object, ReadonlySet<NormalizationState>>();
  private readonly preparedTargetsByResourceRoot = new WeakMap<
    object,
    Map<NormalizationState, Set<string>>
  >();

  constructor(
    private readonly fallbackOpenAPIVersion: string,
    private readonly rejectUnsupportedDialects = false,
  ) {}

  unsupportedDialectSemantics(value: unknown): RefSemantics {
    if (this.rejectUnsupportedDialects) throw unsupportedDialect(value);
    // Ordinary invocation loading still needs standard JSON Schema `$ref`
    // resolution and data-position protection. An unsupported vocabulary is
    // not assigned portable contract meaning here; synthesis opts into the
    // strict branch above before it projects any operation schema into OBI.
    return "compose";
  }

  normalize(value: unknown, resourceUrl?: string, aliases: readonly string[] = []): unknown {
    const document = structuredClone(value);
    const protectedRefKey = unusedProtectedRefKey(document);
    const protectedRefToken = `openbindings-data-ref-${++protectedRefSequence}`;
    const referenceMarkerKey = unusedInternalKey(
      document,
      "x-openbindings-internal-reference-object",
    );
    const referenceMarkerToken = `openbindings-reference-object-${protectedRefSequence}`;
    let tokens = this.protectedRefs.get(protectedRefKey);
    if (!tokens) {
      tokens = new Set();
      this.protectedRefs.set(protectedRefKey, tokens);
    }
    tokens.add(protectedRefToken);
    let markerTokens = this.referenceMarkers.get(referenceMarkerKey);
    if (!markerTokens) {
      markerTokens = new Set();
      this.referenceMarkers.set(referenceMarkerKey, markerTokens);
    }
    markerTokens.add(referenceMarkerToken);
    protectSchemaFields(document, protectedRefKey, protectedRefToken, new WeakSet());

    if (!isObject(document)) return document;

    const declaredVersion = typeof document.openapi === "string" ? document.openapi : "";
    const version = declaredVersion || this.fallbackOpenAPIVersion;
    let targetSemantics = semanticsForVersion(version);
    if (isOpenAPI30(declaredVersion)) {
      normalizeOpenAPIDocument(
        document,
        "ignore",
        protectedRefKey,
        referenceMarkerKey,
        referenceMarkerToken,
        this,
        resourceUrl,
      );
    } else if (isOpenAPI31(declaredVersion)) {
      targetSemantics = default31Semantics(document);
      if (targetSemantics === null) {
        targetSemantics = this.unsupportedDialectSemantics(document.jsonSchemaDialect);
      }
      normalizeOpenAPIDocument(
        document,
        targetSemantics,
        protectedRefKey,
        referenceMarkerKey,
        referenceMarkerToken,
        this,
        resourceUrl,
      );
    } else if (isSupportedOpenAPISchemaDialect(document.$schema)) {
      targetSemantics = "compose";
      normalizeSchema(
        document,
        "compose",
        protectedRefKey,
        new WeakSet(),
        this,
        resourceUrl,
      );
    } else if (document.$schema !== undefined) {
      targetSemantics = this.unsupportedDialectSemantics(document.$schema);
    }

    const state: NormalizationState = {
      semantics: targetSemantics,
      protectedRefKey,
      referenceMarkerKey,
      referenceMarkerToken,
    };
    this.statesByProtectedToken.set(protectedRefToken, state);
    this.normalizeTargets(document, [resourceUrl, ...aliases], resourceUrl, state);

    return document;
  }

  /**
   * Applies target hints discovered after a resource was first fetched.
   *
   * External resources are cached by the generic dereferencer, while their
   * OpenAPI position can be learned incrementally through other external
   * documents. The protected token embedded by {@link normalize} identifies
   * this resource's position-aware normalization state even after the fetch
   * response has been serialized and parsed by the transport-neutral loader.
   */
  prepareTarget(value: Record<string, unknown>, resourceUrl?: string): boolean {
    let states = this.statesByResourceRoot.get(value);
    if (!states) {
      states = normalizationStates(
        value,
        this.statesByProtectedToken,
        new WeakSet(),
      );
      this.statesByResourceRoot.set(value, states);
    }
    let preparedByState = this.preparedTargetsByResourceRoot.get(value);
    if (!preparedByState) {
      preparedByState = new Map();
      this.preparedTargetsByResourceRoot.set(value, preparedByState);
    }
    let prepared = false;
    for (const state of states) {
      let processed = preparedByState.get(state);
      if (!processed) {
        processed = new Set();
        preparedByState.set(state, processed);
      }
      prepared = this.normalizeTargets(
        value,
        [resourceUrl],
        resourceUrl,
        state,
        processed,
      ) || prepared;
    }
    return prepared;
  }

  mergeReferenceObject(
    target: Record<string, unknown>,
    reference: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    let marked = false;
    const merged = { ...target };
    for (const [key, tokens] of this.referenceMarkers) {
      const marker = reference[key];
      if (!isObject(marker) || typeof marker.token !== "string" || !tokens.has(marker.token)) {
        continue;
      }
      marked = true;
      const kind = marker.kind;
      if ((kind === "example" || kind === "pathItemReference")
        && Object.hasOwn(reference, "summary")) {
        merged.summary = reference.summary;
      }
      if (kind !== "callback" && Object.hasOwn(reference, "description")) {
        merged.description = reference.description;
      }
    }
    return marked ? merged : undefined;
  }

  restore(value: unknown): void {
    const seen = new WeakSet<object>();
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      const object = node as Record<string, unknown>;
      for (const [key, tokens] of this.protectedRefs) {
        const wrapped = object[key];
        if (isProtectedSchemaFields(wrapped) && tokens.has(wrapped.token)) {
          for (const [field, fieldValue] of wrapped.values) {
            object[field] = fieldValue;
          }
          delete object[key];
        }
      }
      for (const child of Object.values(object)) walk(child);
    };
    walk(value);
  }

  recordTarget(baseUrl: string | undefined, ref: string, kind: ReferencedKind): void {
    const resolved = resolveRef(baseUrl, ref);
    if (!resolved) return;
    let resourceTargets = this.targets.get(resolved.resource);
    if (!resourceTargets) {
      resourceTargets = new Map();
      this.targets.set(resolved.resource, resourceTargets);
    }
    const target: RefTarget = { fragment: resolved.fragment, kind };
    resourceTargets.set(`${kind}\0${resolved.fragment}`, target);
  }

  private targetsFor(resourceUrls: readonly (string | undefined)[]): RefTarget[] {
    const targets = new Map<string, RefTarget>();
    for (const resourceUrl of resourceUrls) {
      for (const [id, target] of this.targets.get(resourceKey(resourceUrl)) ?? []) {
        targets.set(id, target);
      }
    }
    return [...targets.values()];
  }

  private normalizeTargets(
    document: Record<string, unknown>,
    resourceUrls: readonly (string | undefined)[],
    baseUrl: string | undefined,
    state: NormalizationState,
    processed: Set<string> = new Set(),
  ): boolean {
    // A target can reveal another same-resource target. Iterate to closure so
    // a fetched Parameter -> local Schema -> nested Schema ref chain receives
    // the same position-aware treatment as a complete OpenAPI document.
    let prepared = false;
    for (;;) {
      let progress = false;
      for (const target of this.targetsFor(resourceUrls)) {
        const id = `${target.kind}\0${target.fragment}`;
        if (processed.has(id)) continue;
        let node = target.kind === "schema"
          ? schemaNormalizationRoot(document, target.fragment)
          : fragmentTarget(document, target.fragment);

        // A plain-name schema fragment identifies an anchor in a schema
        // resource. A standalone external schema is allowed to omit a root
        // `$schema`; in that case its anchors are still protected when the
        // first target lookup runs. The schema-kind edge supplies the missing
        // resource identity, so expose only the root schema vocabulary walk
        // (data-valued keywords remain protected), then retry the anchor.
        if (node === undefined && target.kind === "schema"
          && state.semantics === "compose" && isPlainNameFragment(target.fragment)) {
          normalizeSchema(
            document,
            state.semantics,
            state.protectedRefKey,
            new WeakSet(),
            this,
            baseUrl,
          );
          node = schemaNormalizationRoot(document, target.fragment);
        }
        // Do not consume an undiscoverable target. Another external edge can
        // reveal the resource identity needed to locate it on a later pass.
        if (node === undefined) continue;

        processed.add(id);
        prepared = true;
        progress = true;
        normalizeTarget(
          node,
          target.kind,
          state.semantics,
          state.protectedRefKey,
          state.referenceMarkerKey,
          state.referenceMarkerToken,
          this,
          baseUrl,
        );
      }
      if (!progress) break;
    }
    return prepared;
  }
}

function isPlainNameFragment(encodedFragment: string): boolean {
  try {
    const fragment = decodeURIComponent(encodedFragment);
    return fragment !== "" && !fragment.startsWith("/");
  } catch {
    return false;
  }
}

function normalizationStates(
  node: unknown,
  statesByToken: ReadonlyMap<string, NormalizationState>,
  seen: WeakSet<object>,
): Set<NormalizationState> {
  const states = new Set<NormalizationState>();
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (isProtectedSchemaFields(child)) {
        const state = statesByToken.get(child.token);
        if (state) states.add(state);
      }
      walk(child);
    }
  };
  walk(node);
  return states;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOpenAPI30(version: string): boolean {
  return version === "3.0" || version.startsWith("3.0.");
}

function isOpenAPI31(version: string): boolean {
  return version === "3.1" || version.startsWith("3.1.");
}

export function isSupportedOpenAPISchemaDialect(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const uri = value.replace(/#$/, "");
  return uri === "https://json-schema.org/draft/2020-12/schema"
    || uri === "https://spec.openapis.org/oas/3.1/dialect/base";
}

function default31Semantics(root: Record<string, unknown>): RefSemantics | null {
  return root.jsonSchemaDialect === undefined || isSupportedOpenAPISchemaDialect(root.jsonSchemaDialect)
    ? "compose"
    : null;
}

function unsupportedDialect(value: unknown): Error {
  return new Error(
    `cannot preserve OpenAPI Schema Objects under unsupported schema dialect ${JSON.stringify(value)}`,
  );
}

function semanticsForVersion(version: string): RefSemantics | null {
  if (isOpenAPI30(version)) return "ignore";
  if (isOpenAPI31(version)) return "compose";
  return null;
}

function resourceKey(resourceUrl?: string): string {
  if (!resourceUrl) return "";
  try {
    const url = new URL(resourceUrl);
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function resolveRef(
  baseUrl: string | undefined,
  ref: string,
): { resource: string; fragment: string } | undefined {
  try {
    const resolved = baseUrl ? new URL(ref, baseUrl) : new URL(ref);
    const fragment = resolved.hash.slice(1);
    resolved.hash = "";
    return { resource: resolved.href, fragment };
  } catch {
    if (!baseUrl && ref.startsWith("#")) {
      return { resource: "", fragment: ref.slice(1) };
    }
    return undefined;
  }
}

function resolveBase(baseUrl: string | undefined, id: string): string | undefined {
  try {
    return baseUrl ? new URL(id, baseUrl).href : new URL(id).href;
  } catch {
    return baseUrl;
  }
}

function fragmentTarget(root: unknown, encodedFragment: string): unknown {
  let fragment: string;
  try {
    fragment = decodeURIComponent(encodedFragment);
  } catch {
    return undefined;
  }
  if (fragment === "") return root;
  if (!fragment.startsWith("/")) return anchorTarget(root, fragment, new WeakSet(), true);

  let current = root;
  for (const encoded of fragment.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(encoded)) return undefined;
    const segment = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (isObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

interface FragmentPath {
  nodes: unknown[];
  /** `edges[i]` is the object key or array index from nodes[i] to nodes[i + 1]. */
  edges: Array<string | number>;
}

/**
 * Returns the highest Schema Object that encloses one referenced schema
 * fragment. A fetched fragment document does not need a root `$schema`, and
 * its target may sit below a nested `$id`. Normalizing only the pointed leaf
 * would leave that ancestor `$id` protected from the generic dereferencer,
 * causing the leaf's relative refs to resolve from the physical retrieval
 * URI. Walking back through schema-bearing keyword edges lets normalization
 * expose the complete resource path without interpreting arbitrary maps as
 * schemas.
 */
function schemaNormalizationRoot(root: unknown, encodedFragment: string): unknown {
  const target = fragmentTarget(root, encodedFragment);
  if (target === undefined || target === null || typeof target !== "object") return target;

  const path = pointerFragmentPath(root, encodedFragment)
    ?? objectIdentityPath(root, target, new WeakSet());
  if (!path || path.nodes.length === 0) return target;

  let schemaIndex = path.nodes.length - 1;
  for (;;) {
    // Single-schema keywords connect their owner directly to a schema.
    if (schemaIndex >= 1) {
      const directKey = path.edges[schemaIndex - 1];
      if (typeof directKey === "string" && SCHEMA_SINGLE_KEYS.has(directKey)) {
        schemaIndex -= 1;
        continue;
      }
    }

    // Map/array applicators insert one container between the owner schema and
    // the selected member schema (`properties.name`, `allOf[0]`, and so on).
    if (schemaIndex >= 2) {
      const keyword = path.edges[schemaIndex - 2];
      const container = path.nodes[schemaIndex - 1];
      if (typeof keyword === "string" && (
        (isObject(container) && SCHEMA_MAP_KEYS.has(keyword))
        || (Array.isArray(container)
          && (SCHEMA_ARRAY_KEYS.has(keyword) || SCHEMA_SINGLE_KEYS.has(keyword)))
      )) {
        schemaIndex -= 2;
        continue;
      }
    }
    break;
  }
  return path.nodes[schemaIndex];
}

function pointerFragmentPath(root: unknown, encodedFragment: string): FragmentPath | undefined {
  let fragment: string;
  try {
    fragment = decodeURIComponent(encodedFragment);
  } catch {
    return undefined;
  }
  if (fragment === "") return { nodes: [root], edges: [] };
  if (!fragment.startsWith("/")) return undefined;

  const nodes: unknown[] = [root];
  const edges: Array<string | number> = [];
  let current = root;
  for (const encoded of fragment.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(encoded)) return undefined;
    const segment = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) return undefined;
      const index = Number(segment);
      if (index >= current.length) return undefined;
      edges.push(index);
      current = current[index];
    } else if (isObject(current) && Object.hasOwn(current, segment)) {
      edges.push(segment);
      current = current[segment];
    } else {
      return undefined;
    }
    nodes.push(current);
  }
  return { nodes, edges };
}

function objectIdentityPath(
  node: unknown,
  target: object,
  seen: WeakSet<object>,
): FragmentPath | undefined {
  if (!node || typeof node !== "object" || seen.has(node)) return undefined;
  if (node === target) return { nodes: [node], edges: [] };
  seen.add(node);
  const entries: Array<[string | number, unknown]> = Array.isArray(node)
    ? node.map((child, index) => [index, child])
    : Object.entries(node as Record<string, unknown>);
  for (const [edge, child] of entries) {
    const nested = objectIdentityPath(child, target, seen);
    if (nested) {
      return { nodes: [node, ...nested.nodes], edges: [edge, ...nested.edges] };
    }
  }
  return undefined;
}

function anchorTarget(
  node: unknown,
  anchor: string,
  seen: WeakSet<object>,
  resourceRoot: boolean,
): unknown {
  if (!node || typeof node !== "object" || seen.has(node)) return undefined;
  seen.add(node);
  if (!Array.isArray(node)) {
    const object = node as Record<string, unknown>;
    // A nested `$id` establishes another schema resource. Anchors below that
    // boundary never resolve through a fragment on the parent resource.
    if (!resourceRoot && typeof object.$id === "string") return undefined;
    if (object.$anchor === anchor || object.$dynamicAnchor === anchor) return object;
  }
  for (const child of Object.values(node)) {
    const found = anchorTarget(child, anchor, seen, false);
    if (found !== undefined) return found;
  }
  return undefined;
}

function unusedProtectedRefKey(value: unknown): string {
  return unusedInternalKey(value, "x-openbindings-internal-data-ref");
}

function unusedInternalKey(value: unknown, base: string): string {
  const keys = new Set<string>();
  const seen = new WeakSet<object>();
  const collect = (node: unknown): void => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) collect(item);
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      keys.add(key);
      collect(child);
    }
  };
  collect(value);
  if (!keys.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!keys.has(candidate)) return candidate;
  }
}

function protectSchemaFields(
  node: unknown,
  key: string,
  token: string,
  seen: WeakSet<object>,
): void {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) protectSchemaFields(item, key, token, seen);
    return;
  }
  const object = node as Record<string, unknown>;
  const values: Array<[string, unknown]> = [];
  for (const field of SCHEMA_SCOPE_KEYS) {
    if (!Object.hasOwn(object, field)) continue;
    values.push([field, object[field]]);
    delete object[field];
  }
  if (values.length > 0) {
    const wrapped: ProtectedSchemaFields = { token, values };
    object[key] = wrapped;
  }
  for (const [childKey, child] of Object.entries(object)) {
    if (childKey !== key) protectSchemaFields(child, key, token, seen);
  }
}

function exposeRef(node: Record<string, unknown>, key: string): boolean {
  const wrapped = node[key];
  if (isProtectedSchemaFields(wrapped)) {
    const index = wrapped.values.findIndex(([field]) => field === "$ref");
    if (index >= 0) {
      node.$ref = wrapped.values[index]![1];
      wrapped.values.splice(index, 1);
      if (wrapped.values.length === 0) delete node[key];
    }
  }
  return typeof node.$ref === "string";
}

function exposeSchemaFields(node: Record<string, unknown>, key: string): void {
  const wrapped = node[key];
  if (!isProtectedSchemaFields(wrapped)) return;
  for (const [field, value] of wrapped.values) node[field] = value;
  delete node[key];
}

function isProtectedSchemaFields(value: unknown): value is ProtectedSchemaFields {
  return isObject(value) && typeof value.token === "string" && Array.isArray(value.values);
}

interface WalkContext {
  semantics: RefSemantics | null;
  refKey: string;
  referenceMarkerKey: string;
  referenceMarkerToken: string;
  normalizer: OpenAPIRefSiblingNormalizer;
  baseUrl?: string;
}

function normalizeOpenAPIDocument(
  root: Record<string, unknown>,
  schemaSemantics: RefSemantics | null,
  protectedRefKey: string,
  referenceMarkerKey: string,
  referenceMarkerToken: string,
  normalizer: OpenAPIRefSiblingNormalizer,
  baseUrl?: string,
): void {
  const context: WalkContext = {
    semantics: schemaSemantics,
    refKey: protectedRefKey,
    referenceMarkerKey,
    referenceMarkerToken,
    normalizer,
    baseUrl,
  };
  walkPathItemMap(root.paths, context);
  walkReferenceMap(root.webhooks, "pathItemReference", context);

  if (!isObject(root.components)) return;
  const components = root.components;
  walkSchemaMap(components.schemas, context);
  walkReferenceMap(components.responses, "response", context);
  walkReferenceMap(components.parameters, "parameter", context);
  walkReferenceMap(components.examples, "example", context);
  walkReferenceMap(components.requestBodies, "requestBody", context);
  walkReferenceMap(components.headers, "header", context);
  walkReferenceMap(components.securitySchemes, "opaque", context);
  walkReferenceMap(components.links, "opaque", context);
  walkReferenceMap(components.callbacks, "callback", context);
  walkReferenceMap(components.pathItems, "pathItemReference", context);
}

function normalizeTarget(
  value: unknown,
  kind: ReferencedKind,
  semantics: RefSemantics | null,
  refKey: string,
  referenceMarkerKey: string,
  referenceMarkerToken: string,
  normalizer: OpenAPIRefSiblingNormalizer,
  baseUrl?: string,
): void {
  const context: WalkContext = {
    semantics,
    refKey,
    referenceMarkerKey,
    referenceMarkerToken,
    normalizer,
    baseUrl,
  };
  if (kind === "schema") {
    normalizeSchema(value, semantics, refKey, new WeakSet(), normalizer, baseUrl);
  } else {
    walkReferenceOrObject(value, kind, context);
  }
}

function walkPathItemMap(value: unknown, context: WalkContext): void {
  if (!isObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (!key.startsWith("x-")) walkPathItem(item, context);
  }
}

function walkPathItem(value: unknown, context: WalkContext): void {
  if (!isObject(value)) return;
  // Path Item `$ref` is its own OpenAPI field, not a Reference Object. Its
  // sibling behavior is therefore not changed by Reference Object rules.
  if (exposeRef(value, context.refKey) && typeof value.$ref === "string") {
    context.normalizer.recordTarget(context.baseUrl, value.$ref, "pathItem");
  }
  walkParameterArray(value.parameters, context);
  for (const operation of OPERATION_KEYS) walkOperation(value[operation], context);
}

function walkOperation(value: unknown, context: WalkContext): void {
  if (!isObject(value)) return;
  walkParameterArray(value.parameters, context);
  walkReferenceOrObject(value.requestBody, "requestBody", context);
  walkResponses(value.responses, context);
  if (isObject(value.callbacks)) {
    for (const callback of Object.values(value.callbacks)) {
      walkReferenceOrObject(callback, "callback", context);
    }
  }
}

function walkParameterArray(value: unknown, context: WalkContext): void {
  if (!Array.isArray(value)) return;
  for (const parameter of value) walkReferenceOrObject(parameter, "parameter", context);
}

function walkReferenceMap(
  value: unknown,
  kind: Exclude<ReferencedKind, "schema">,
  context: WalkContext,
): void {
  if (!isObject(value)) return;
  for (const item of Object.values(value)) walkReferenceOrObject(item, kind, context);
}

function walkReferenceOrObject(
  value: unknown,
  kind: Exclude<ReferencedKind, "schema">,
  context: WalkContext,
): void {
  if (!isObject(value)) return;
  if (exposeRef(value, context.refKey) && typeof value.$ref === "string") {
    context.normalizer.recordTarget(context.baseUrl, value.$ref, kind);
    if (context.semantics === "ignore" && kind !== "pathItem") {
      stripRefSiblings(value);
    } else if (context.semantics === "compose" && kind !== "pathItem") {
      for (const key of Object.keys(value)) {
        if (key !== "$ref" && key !== "summary" && key !== "description") delete value[key];
      }
      value[context.referenceMarkerKey] = {
        token: context.referenceMarkerToken,
        kind,
      };
    }
    // The resolver recognizes this position marker and overlays only the two
    // legal reference annotations; it never treats structural siblings as
    // fields of the referenced object.
    return;
  }
  switch (kind) {
    case "response": walkResponse(value, context); break;
    case "parameter": walkParameter(value, context); break;
    case "example": break; // `value` is arbitrary data and stays protected.
    case "requestBody": walkContent(value.content, context); break;
    case "header": walkParameter(value, context); break;
    case "callback": walkPathItemMap(value, context); break;
    case "pathItem": walkPathItem(value, context); break;
    case "pathItemReference": walkPathItem(value, context); break;
    case "opaque": break;
  }
}

function stripRefSiblings(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    if (key !== "$ref") delete value[key];
  }
}

function walkParameter(value: Record<string, unknown>, context: WalkContext): void {
  normalizeSchema(
    value.schema,
    context.semantics,
    context.refKey,
    new WeakSet(),
    context.normalizer,
    context.baseUrl,
  );
  walkContent(value.content, context);
  walkExampleMap(value.examples, context);
}

function walkResponses(value: unknown, context: WalkContext): void {
  if (!isObject(value)) return;
  for (const [key, response] of Object.entries(value)) {
    if (!key.startsWith("x-")) walkReferenceOrObject(response, "response", context);
  }
}

function walkResponse(value: Record<string, unknown>, context: WalkContext): void {
  walkReferenceMap(value.headers, "header", context);
  walkContent(value.content, context);
  walkReferenceMap(value.links, "opaque", context);
}

function walkContent(value: unknown, context: WalkContext): void {
  if (!isObject(value)) return;
  for (const [key, media] of Object.entries(value)) {
    if (key.startsWith("x-") || !isObject(media)) continue;
    normalizeSchema(
      media.schema,
      context.semantics,
      context.refKey,
      new WeakSet(),
      context.normalizer,
      context.baseUrl,
    );
    walkExampleMap(media.examples, context);
    if (isObject(media.encoding)) {
      for (const encoding of Object.values(media.encoding)) {
        if (isObject(encoding)) walkReferenceMap(encoding.headers, "header", context);
      }
    }
  }
}

function walkExampleMap(value: unknown, context: WalkContext): void {
  walkReferenceMap(value, "example", context);
}

function walkSchemaMap(value: unknown, context: WalkContext): void {
  if (!isObject(value)) return;
  for (const schema of Object.values(value)) {
    normalizeSchema(
      schema,
      context.semantics,
      context.refKey,
      new WeakSet(),
      context.normalizer,
      context.baseUrl,
    );
  }
}

function normalizeSchema(
  node: unknown,
  inherited: RefSemantics | null,
  refKey: string,
  seen: WeakSet<object>,
  normalizer: OpenAPIRefSiblingNormalizer,
  baseUrl?: string,
): void {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) normalizeSchema(item, inherited, refKey, seen, normalizer, baseUrl);
    return;
  }
  const schema = node as Record<string, unknown>;
  exposeSchemaFields(schema, refKey);
  const semantics = schema.$schema === undefined
    ? inherited
    : isSupportedOpenAPISchemaDialect(schema.$schema)
      ? "compose"
      : null;
  const resolvedSemantics = semantics ?? normalizer.unsupportedDialectSemantics(schema.$schema);
  const schemaBase = typeof schema.$id === "string" ? resolveBase(baseUrl, schema.$id) : baseUrl;

  if (typeof schema.$ref === "string") {
    normalizer.recordTarget(schemaBase, schema.$ref, "schema");
  }
  if (typeof schema.$ref === "string" && Object.keys(schema).length > 1) {
    if (resolvedSemantics === "ignore") {
      stripRefSiblings(schema);
      return;
    }
    const ref = schema.$ref;
    delete schema.$ref;
    if (schema.allOf === undefined) {
      schema.allOf = [{ $ref: ref }];
    } else if (Array.isArray(schema.allOf)) {
      schema.allOf = [{ $ref: ref }, ...(schema.allOf as unknown[])];
    } else {
      throw new Error("a Schema Object with $ref siblings declares non-array allOf");
    }
  }
  for (const [key, child] of Object.entries(schema)) {
    if (SCHEMA_MAP_KEYS.has(key)) {
      if (!isObject(child)) continue;
      for (const value of Object.values(child)) {
        normalizeSchema(value, resolvedSemantics, refKey, seen, normalizer, schemaBase);
      }
    } else if (SCHEMA_ARRAY_KEYS.has(key)) {
      if (!Array.isArray(child)) continue;
      for (const value of child) {
        normalizeSchema(value, resolvedSemantics, refKey, seen, normalizer, schemaBase);
      }
    } else if (SCHEMA_SINGLE_KEYS.has(key)) {
      normalizeSchema(child, resolvedSemantics, refKey, seen, normalizer, schemaBase);
    }
  }
}

/**
 * Lightweight, browser-compatible JSON $ref dereferencer.
 *
 * Resolves both internal (`#/...`) and external (`./file.json`,
 * `https://...`) $ref pointers. External refs are fetched via the
 * global `fetch` API, so this works in both browsers and Node 18+.
 *
 * Circular references are detected and left as shared object
 * references (no infinite recursion).
 */

export interface DereferenceOptions {
  /** Base URL for resolving relative external $refs. */
  baseUrl?: string;
  /** Custom fetch function (defaults to globalThis.fetch). */
  fetch?: typeof globalThis.fetch;
  /** Abort signal for cancelling external fetches. */
  signal?: AbortSignal;
  /**
   * Optional parser for non-JSON content (e.g. YAML). Receives the raw
   * response text and should return a parsed object. If not provided,
   * external refs are parsed as JSON only.
   */
  parse?: (text: string) => unknown;
  /**
   * Optionally replace the default target-wins `$ref` sibling merge for a
   * recognized reference object. Returning `undefined` keeps the default.
   * Format adapters use this only after position-aware classification.
   */
  mergeRefSiblings?: (
    target: Record<string, unknown>,
    reference: Record<string, unknown>,
  ) => Record<string, unknown> | undefined;
  /**
   * Optional format-adapter hook invoked immediately before a reference
   * fragment is resolved against a resource. It may expose reference
   * semantics at a target whose format-defined position was discovered only
   * after that external resource had already been fetched and cached.
   * Generic dereferencing remains unchanged when omitted.
   */
  prepareRefTarget?: (
    root: Record<string, unknown>,
    target: { resourceURI?: string; fragment: string },
  ) => boolean | void;
  /**
   * Preserve a `$ref` object when its fragment does not resolve instead of
   * rejecting the complete document. Strict rejection remains the default.
   * This is intended for processors that inventory and exclude invalid
   * targets individually after dereferencing the rest of the artifact.
   */
  allowUnresolved?: boolean;
}

/** Resolve a JSON Pointer (RFC 6901) against a root object. */
function resolvePointer(root: Record<string, unknown>, pointer: string): unknown {
  const isFragment = pointer.startsWith("#");
  let path = isFragment ? pointer.slice(1) : pointer;
  if (isFragment) {
    try {
      // RFC 6901 §6: decode the URI fragment before evaluating its pointer.
      path = decodeURIComponent(path);
    } catch {
      return undefined;
    }
  }
  if (path === "") return root;
  if (!path.startsWith("/")) return undefined;

  const tokens: string[] = [];
  for (const encoded of path.slice(1).split("/")) {
    // A literal "~" is not legal in a reference token; it must be ~0.
    if (/~(?:[^01]|$)/.test(encoded)) return undefined;
    tokens.push(encoded.replace(/~1/g, "/").replace(/~0/g, "~"));
  }

  let current: unknown = root;
  for (const token of tokens) {
    if (current == null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      // RFC 6901 §4: array indexes are base-10 with no leading zeroes.
      if (!/^(?:0|[1-9][0-9]*)$/.test(token)) return undefined;
      const idx = Number(token);
      if (!Number.isSafeInteger(idx) || !Object.hasOwn(current, idx)) return undefined;
      current = current[idx];
    } else {
      if (!Object.hasOwn(current, token)) return undefined;
      current = (current as Record<string, unknown>)[token];
    }
  }
  return current;
}

function withoutFragment(uri: string): string {
  const hash = uri.indexOf("#");
  return hash < 0 ? uri : uri.slice(0, hash);
}

function resolveURI(base: string | undefined, reference: string): string | undefined {
  try {
    return base ? new URL(reference, base).href : new URL(reference).href;
  } catch {
    return undefined;
  }
}

/** Default parser: try JSON, fall back to returning the text as-is. */
function defaultParse(text: string): unknown {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(text);
  }
  // Can't parse non-JSON without a custom parser; throw a clear error.
  throw new Error("External $ref returned non-JSON content. Pass a 'parse' option to dereference() to handle YAML or other formats.");
}

/** Fetch and parse a document. */
async function fetchDocument(
  url: string,
  doFetch: typeof globalThis.fetch,
  parse: (text: string) => unknown,
  signal?: AbortSignal,
): Promise<{ document: Record<string, unknown>; retrievalURI: string }> {
  const resp = await doFetch(url, { signal });
  if (!resp.ok) {
    throw new Error(`failed to fetch $ref ${url}: ${resp.status}`);
  }
  const text = await resp.text();
  const parsed = parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`external $ref ${url} did not return an object document`);
  }
  return {
    document: parsed as Record<string, unknown>,
    // Fetch exposes the final retrieval URI after redirects. When a test or
    // host fetch implementation cannot provide it, the requested URI remains
    // the only available base.
    retrievalURI: resp.url || url,
  };
}

interface ResourceScope {
  root: Record<string, unknown>;
  baseURI?: string;
  anchors: Map<string, unknown>;
}

interface DocumentContext {
  root: Record<string, unknown>;
  rootScope: ResourceScope;
}

/**
 * Dereferences all `$ref` pointers in a JSON/YAML document.
 *
 * Internal refs (`#/...`) are resolved within the document.
 * External refs are fetched, cached, and recursively dereferenced.
 * Returns a new object (the original is not mutated).
 */
export async function dereference<T = unknown>(
  doc: Record<string, unknown>,
  options?: DereferenceOptions,
): Promise<T> {
  const doFetch = options?.fetch ?? globalThis.fetch;
  const parse = options?.parse ?? defaultParse;
  const baseUrl = options?.baseUrl;
  const signal = options?.signal;
  const allowUnresolved = options?.allowUnresolved ?? false;
  const mergeRefSiblings = options?.mergeRefSiblings;
  const prepareRefTarget = options?.prepareRefTarget;

  // The single working tree. Internal refs resolve against THIS clone, never
  // the caller's `doc`: resolving against the original both mutates the
  // caller's document in place (walkAsync rewrites nodes) and aliases resolved
  // output nodes back to the input, contradicting the no-mutate contract above.
  const cloned = structuredClone(doc);

  // Every document is indexed before traversal. OAS 3.1 requires complete
  // document parsing because a later $id can establish the resource/base that
  // an earlier reference denotes. The maps also keep fragment-only references
  // inside an external document scoped to THAT document, not the entrypoint.
  const scopeByNode = new WeakMap<object, ResourceScope>();
  const parentScopeByNode = new WeakMap<object, ResourceScope>();
  const aliasesByDocumentRoot = new WeakMap<object, readonly string[]>();
  const resourcesByURI = new Map<string, ResourceScope>();

  function indexResourceSubtree(node: unknown, inherited: ResourceScope): void {
    const seen = new WeakSet<object>();
    const index = (value: unknown, parent: ResourceScope): void => {
      if (value === null || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);

      if (Array.isArray(value)) {
        parentScopeByNode.set(value, parent);
        scopeByNode.set(value, parent);
        for (const child of value) index(child, parent);
        return;
      }

      const object = value as Record<string, unknown>;
      parentScopeByNode.set(object, parent);
      let scope = parent;
      if (typeof object.$id === "string") {
        const resolvedID = resolveURI(parent.baseURI, object.$id);
        scope = {
          root: object,
          baseURI: resolvedID ? withoutFragment(resolvedID) : undefined,
          anchors: new Map(),
        };
        if (scope.baseURI) resourcesByURI.set(scope.baseURI, scope);
      }
      scopeByNode.set(object, scope);
      if (typeof object.$anchor === "string") {
        scope.anchors.set(object.$anchor, object);
      }
      if (typeof object.$dynamicAnchor === "string") {
        scope.anchors.set(object.$dynamicAnchor, object);
      }
      for (const child of Object.values(object)) index(child, scope);
    };
    index(node, inherited);
  }

  function registerDocument(
    root: Record<string, unknown>,
    retrievalURI?: string,
    requestedURI?: string,
  ): DocumentContext {
    const rootScope: ResourceScope = {
      root,
      baseURI: retrievalURI ? withoutFragment(retrievalURI) : undefined,
      anchors: new Map(),
    };
    const aliases = [...new Set([
      retrievalURI && withoutFragment(retrievalURI),
      requestedURI && withoutFragment(requestedURI),
    ].filter((uri): uri is string => typeof uri === "string"))];
    aliasesByDocumentRoot.set(root, aliases);
    indexResourceSubtree(root, rootScope);
    const effectiveRootScope = scopeByNode.get(root) ?? rootScope;
    for (const alias of aliases) resourcesByURI.set(alias, effectiveRootScope);
    return { root, rootScope: effectiveRootScope };
  }

  const entryContext = registerDocument(cloned, baseUrl);

  interface ExternalRecord {
    context?: DocumentContext;
    ready?: Promise<DocumentContext>;
  }
  const externalCache = new Map<string, ExternalRecord>();

  async function resolveExternal(url: string): Promise<DocumentContext> {
    const key = withoutFragment(url);
    const cached = externalCache.get(key);
    if (cached?.context) return cached.context;
    if (cached?.ready) return cached.ready;

    const record: ExternalRecord = {};
    externalCache.set(key, record);
    record.ready = (async () => {
      const fetched = await fetchDocument(key, doFetch, parse, signal);
      const context = registerDocument(fetched.document, fetched.retrievalURI, key);
      // Publish the parsed/indexed document before walking it. A circular
      // external edge can now resolve back to this object graph without
      // awaiting itself; resolvedNodes below terminates the object cycle.
      record.context = context;
      await walkAsync(context.root, context);
      return context;
    })();
    return record.ready;
  }

  // A node may be reached through several refs, including through an alias
  // component whose own value is another ref. Remember the RESOLVED result,
  // not merely that traversal started: a global seen-set can strand the
  // original alias object as `{$ref: ...}` when its first traversal result
  // was returned to a different parent.
  const resolvedNodes = new Map<object, unknown>();

  function invalidateResolvedSubtree(node: unknown, preserve: object): void {
    const seen = new WeakSet<object>();
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== "object" || value === preserve || seen.has(value)) {
        return;
      }
      seen.add(value);
      resolvedNodes.delete(value);
      for (const child of Object.values(value)) walk(child);
    };
    walk(node);
  }

  function reindexPreparedResource(
    root: Record<string, unknown>,
    inherited: ResourceScope,
    owner: object,
  ): ResourceScope {
    // Target preparation can expose `$id`, `$anchor`, or `$dynamicAnchor`
    // fields that were deliberately hidden during the resource's initial
    // format-neutral index. Re-index before traversal so nested refs inherit
    // their newly visible resource base and anchor table.
    indexResourceSubtree(root, parentScopeByNode.get(root) ?? inherited);
    const effectiveRootScope = scopeByNode.get(root) ?? inherited;
    for (const alias of aliasesByDocumentRoot.get(root) ?? []) {
      resourcesByURI.set(alias, effectiveRootScope);
    }
    // A single preparation pass can expose a closure of same-resource
    // targets, not only the fragment currently being resolved. Invalidate
    // the complete resource so each newly exposed edge is revisited.
    invalidateResolvedSubtree(root, owner);
    return effectiveRootScope;
  }

  function resolveFragment(scope: ResourceScope, fragment: string): unknown {
    if (fragment === "" || fragment === "#") return scope.root;
    let decoded: string;
    try {
      decoded = decodeURIComponent(fragment.startsWith("#") ? fragment.slice(1) : fragment);
    } catch {
      return undefined;
    }
    if (decoded.startsWith("/")) return resolvePointer(scope.root, `#${decoded}`);
    return scope.anchors.get(decoded);
  }

  async function resolveReference(
    ref: string,
    owner: Record<string, unknown>,
    document: DocumentContext,
  ): Promise<unknown> {
    let scope = scopeByNode.get(owner) ?? document.rootScope;
    if (ref.startsWith("#")) {
      const prepared = prepareRefTarget?.(scope.root, {
        resourceURI: scope.baseURI,
        fragment: ref,
      });
      if (prepared) scope = reindexPreparedResource(scope.root, scope, owner);
      const target = resolveFragment(scope, ref);
      return target;
    }

    const absolute = resolveURI(scope.baseURI, ref);
    if (!absolute) {
      throw new Error(
        `reference ${JSON.stringify(ref)} cannot resolve without a base URI; the document must be self-contained or supplied with a base`,
      );
    }
    const hash = absolute.indexOf("#");
    const resourceURI = hash < 0 ? absolute : absolute.slice(0, hash);
    const fragment = hash < 0 ? "" : absolute.slice(hash);

    let resource = resourcesByURI.get(resourceURI);
    if (!resource) {
      const external = await resolveExternal(resourceURI);
      resource = resourcesByURI.get(resourceURI) ?? external.rootScope;
    }
    const prepared = prepareRefTarget?.(resource.root, { resourceURI, fragment });
    if (prepared) resource = reindexPreparedResource(resource.root, resource, owner);
    const target = resolveFragment(resource, fragment);
    return target;
  }

  async function walkAsync(node: unknown, document: DocumentContext): Promise<unknown> {
    if (node == null || typeof node !== "object") return node;
    if (resolvedNodes.has(node)) return resolvedNodes.get(node);

    if (Array.isArray(node)) {
      resolvedNodes.set(node, node);
      for (let i = 0; i < node.length; i++) {
        node[i] = await walkAsync(node[i], document);
      }
      return node;
    }

    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === "string") {
      // Reserve before following the edge so document-root and recursive
      // refs terminate. The reservation is replaced with the actual result
      // once the target (and any siblings) has resolved.
      resolvedNodes.set(obj, obj);
      const ref = obj.$ref;
      const target = await resolveReference(ref, obj, document);

      if (target !== undefined) {
        const extraKeys = Object.keys(obj).filter((k) => k !== "$ref");
        if (extraKeys.length > 0 && typeof target === "object" && target !== null) {
          const customMerged = mergeRefSiblings?.(
            target as Record<string, unknown>,
            obj,
          );
          const merged = customMerged ?? { ...target };
          // A synthetic sibling-merge object still belongs to the target's
          // resource. Without carrying that scope, a target whose own root is
          // another relative ref would incorrectly resolve from the referring
          // document merely because the merge allocated a new object.
          scopeByNode.set(merged, scopeByNode.get(target) ?? document.rootScope);
          for (const k of extraKeys) {
            if (!Object.hasOwn(merged, k) && customMerged === undefined) {
              Object.defineProperty(merged, k, {
                value: obj[k],
                enumerable: true,
                configurable: true,
                writable: true,
              });
            }
          }
          const resolved = await walkAsync(merged, document);
          resolvedNodes.set(obj, resolved);
          return resolved;
        }
        const resolved = await walkAsync(target, document);
        resolvedNodes.set(obj, resolved);
        return resolved;
      }
      if (allowUnresolved) return obj;
      throw new Error(`unresolvable $ref ${JSON.stringify(ref)}`);
    }

    resolvedNodes.set(obj, obj);
    for (const key of Object.keys(obj)) {
      obj[key] = await walkAsync(obj[key], document);
    }
    return obj;
  }

  return await walkAsync(cloned, entryContext) as T;
}

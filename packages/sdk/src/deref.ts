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
}

/** Resolve a JSON Pointer (RFC 6901) against a root object. */
function resolvePointer(root: Record<string, unknown>, pointer: string): unknown {
  const fragment = pointer.startsWith("#/") ? pointer.slice(2) : pointer;
  if (!fragment) return root;

  const tokens = fragment
    .split("/")
    .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));

  let current: unknown = root;
  for (const token of tokens) {
    if (current == null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      const idx = parseInt(token, 10);
      if (Number.isNaN(idx)) return undefined;
      current = current[idx];
    } else {
      current = (current as Record<string, unknown>)[token];
    }
  }
  return current;
}

/** Split a $ref into [url, fragment]. Internal refs return ["", pointer]. */
function splitRef(ref: string): [string, string] {
  if (ref.startsWith("#")) return ["", ref];
  const hashIdx = ref.indexOf("#");
  if (hashIdx === -1) return [ref, ""];
  return [ref.slice(0, hashIdx), ref.slice(hashIdx)];
}

/** Resolve a possibly-relative URL against a base. */
function resolveUrl(base: string | undefined, relative: string): string {
  if (relative.startsWith("http://") || relative.startsWith("https://")) {
    return relative;
  }
  if (!base) return relative;
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
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
): Promise<Record<string, unknown>> {
  const resp = await doFetch(url, { signal });
  if (!resp.ok) {
    throw new Error(`failed to fetch $ref ${url}: ${resp.status}`);
  }
  const text = await resp.text();
  return parse(text) as Record<string, unknown>;
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

  // Cache of fetched + dereferenced external documents.
  const externalCache = new Map<string, Record<string, unknown>>();

  async function resolveExternal(url: string): Promise<Record<string, unknown>> {
    const cached = externalCache.get(url);
    if (cached) return cached;

    const raw = await fetchDocument(url, doFetch, parse, signal);
    // Placeholder to break circular external refs.
    externalCache.set(url, raw);

    const resolved = await walkAsync(raw, url) as Record<string, unknown>;
    externalCache.set(url, resolved);
    return resolved;
  }

  const seen = new Set<unknown>();

  async function walkAsync(node: unknown, currentBase?: string): Promise<unknown> {
    if (node == null || typeof node !== "object") return node;
    if (seen.has(node)) return node;
    seen.add(node);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        node[i] = await walkAsync(node[i], currentBase);
      }
      return node;
    }

    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === "string") {
      const [externalUrl, fragment] = splitRef(obj.$ref);

      let targetDoc: Record<string, unknown>;
      let resolvedBase = currentBase;

      if (externalUrl) {
        const fullUrl = resolveUrl(currentBase ?? baseUrl, externalUrl);
        targetDoc = await resolveExternal(fullUrl);
        resolvedBase = fullUrl;
      } else {
        targetDoc = doc;
      }

      const target = fragment
        ? resolvePointer(targetDoc, fragment)
        : targetDoc;

      if (target !== undefined) {
        const extraKeys = Object.keys(obj).filter((k) => k !== "$ref");
        if (extraKeys.length > 0 && typeof target === "object" && target !== null) {
          const merged = { ...target } as Record<string, unknown>;
          for (const k of extraKeys) {
            if (!(k in merged)) merged[k] = obj[k];
          }
          return walkAsync(merged, resolvedBase);
        }
        return walkAsync(target, resolvedBase);
      }
    }

    for (const key of Object.keys(obj)) {
      obj[key] = await walkAsync(obj[key], currentBase);
    }
    return obj;
  }

  return await walkAsync(structuredClone(doc), baseUrl) as T;
}

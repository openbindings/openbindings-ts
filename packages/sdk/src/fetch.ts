import type { OBInterface } from "./types.js";
import type { InterfaceSynthesizer } from "./invokers.js";
import { isHttpUrl } from "./helpers.js";
import { combineSynthesizers } from "./combiners.js";
import { parseDocument } from "./parse.js";
import { isOBInterface } from "./compatibility.js";

export const WELL_KNOWN_PATH = "/.well-known/openbindings";

/** Registered media type for OpenBindings documents. */
export const MEDIA_TYPE = "application/vnd.openbindings+json";

export interface FetchInterfaceOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  /**
   * Synthesizers for synthesizing OBIs from non-OBI sources (e.g. OpenAPI,
   * AsyncAPI). When the URL doesn't serve an OBI directly and well-known
   * discovery fails, each synthesizer is tried in turn.
   */
  synthesizers?: InterfaceSynthesizer[];
}

export interface FetchedInterface {
  iface: OBInterface;
  /** True when the OBI was synthesized from a non-OBI source. */
  synthesized: boolean;
}

/**
 * Resolves an OBI from a URL. For HTTP URLs, tries direct fetch first,
 * then well-known discovery at `/.well-known/openbindings`. If neither
 * yields an OBI and synthesizers are supplied, synthesizes from the URL's
 * content (e.g., an OpenAPI doc).
 *
 * Throws if the OBI can't be acquired.
 */
export async function fetchInterface(
  url: string,
  opts?: FetchInterfaceOptions,
): Promise<FetchedInterface> {
  const fetchFn = opts?.fetch ?? defaultFetch();
  const signal = opts?.signal;
  const synthesizer = opts?.synthesizers?.length ? combineSynthesizers(...opts.synthesizers) : null;

  if (isHttpUrl(url)) {
    const direct = await tryFetchOBI(fetchFn, url, signal);
    if (direct) return { iface: direct, synthesized: false };

    if (!shouldSkipWellKnownDiscovery(url)) {
      const wellKnown = await tryFetchOBI(
        fetchFn,
        url.replace(/\/+$/, "") + WELL_KNOWN_PATH,
        signal,
      );
      if (wellKnown) return { iface: wellKnown, synthesized: false };
    }
  }

  if (!synthesizer) {
    throw new Error(`No OBI available at ${url} and no synthesizers supplied for synthesis`);
  }

  const formats = synthesizer.formats();
  let lastError: unknown;
  for (const info of formats) {
    try {
      const iface = await synthesizer.synthesizeInterface(
        { sources: [{ format: info.token, location: url }] },
        { signal },
      );
      return { iface, synthesized: true };
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError ?? new Error(`No synthesizer could synthesize an interface from ${url}`);
}

function defaultFetch(): typeof globalThis.fetch {
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis);
  }
  return (() => Promise.reject(new Error(
    "openbindings: fetch is not available — provide a fetch implementation via FetchInterfaceOptions",
  ))) as typeof globalThis.fetch;
}

async function tryFetchOBI(
  fetchFn: typeof globalThis.fetch,
  url: string,
  signal?: AbortSignal,
): Promise<OBInterface | null> {
  const resp = await fetchFn(url, {
    signal,
    headers: { Accept: "application/vnd.openbindings+json, application/json" },
  });
  if (!resp.ok) return null;
  const text = await resp.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (isOBInterface(body)) return parseDocument(text);
  return null;
}

function shouldSkipWellKnownDiscovery(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return (
      path.endsWith(".json") ||
      path.endsWith(".yaml") ||
      path.endsWith(".yml") ||
      path.includes("/openapi") ||
      path.includes("/swagger") ||
      path.includes("/asyncapi") ||
      path.endsWith(WELL_KNOWN_PATH)
    );
  } catch {
    return false;
  }
}

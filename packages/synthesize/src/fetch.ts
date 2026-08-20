import type { OBInterface } from "@openbindings/core";
import { WELL_KNOWN_PATH, isHttpUrl, isOBInterface, parseDocument } from "@openbindings/core";
import type { InterfaceSynthesizer } from "./synthesizer.js";
import type { SynthesisCoverage } from "./synthesizer-types.js";
import { combineSynthesizers } from "./combiners.js";
import { SynthesisCoverageUnsupportedError } from "./errors.js";

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
  /** Durable evidence from the synthesis call; absent for fetched OBIs. */
  coverage?: SynthesisCoverage;
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

  // The resolution chain has up to three steps (direct OBI, well-known
  // discovery, binding-spec synthesis). On total failure the caller gets the
  // WHOLE trail: reporting only the last step's raw error hands a user who
  // pointed at an API's HTML root a third-party parse error with no statement
  // of what was tried or how to fix it. Mirrors the Go SDK.
  const trail: string[] = [];

  if (isHttpUrl(url)) {
    const direct = await tryFetchOBI(fetchFn, url, signal);
    if (direct.iface) return { iface: direct.iface, synthesized: false };
    trail.push(`direct fetch: ${direct.result}`);

    if (!shouldSkipWellKnownDiscovery(url)) {
      const wellKnown = await tryFetchOBI(
        fetchFn,
        url.replace(/\/+$/, "") + WELL_KNOWN_PATH,
        signal,
      );
      if (wellKnown.iface) return { iface: wellKnown.iface, synthesized: false };
      trail.push(`${WELL_KNOWN_PATH}: ${wellKnown.result}`);
    }
  }

  if (!synthesizer) {
    if (trail.length > 0) {
      throw new Error(
        `no OBI available at ${sanitizeUrl(url)} (${trail.join("; ")}) and no synthesizers supplied for synthesis`,
      );
    }
    throw new Error(
      `no OBI available at ${sanitizeUrl(url)} and no synthesizers supplied for synthesis`,
    );
  }

  for (const info of synthesizer.bindingSpecs()) {
    let iface: OBInterface;
    let coverage: SynthesisCoverage | undefined;
    const input = { sources: [{ bindingSpec: info.bindingSpec, location: url }] };
    try {
      const result = await synthesizer.synthesizeInterfaceWithCoverage(input, { signal });
      iface = result.interface;
      coverage = result.coverage;
    } catch (e) {
      if (e instanceof SynthesisCoverageUnsupportedError) {
        try {
          iface = await synthesizer.synthesizeInterface(input, { signal });
        } catch (fallbackError) {
          trail.push(`synthesize as ${info.bindingSpec}: ${errText(fallbackError)}`);
          continue;
        }
      } else {
        trail.push(`synthesize as ${info.bindingSpec}: ${errText(e)}`);
        continue;
      }
    }
    if (iface && iface.operations && Object.keys(iface.operations).length > 0) {
      return { iface, synthesized: true, coverage };
    }
    trail.push(`synthesize as ${info.bindingSpec}: no operations derived`);
  }

  throw new Error(
    `could not resolve an OBI from ${sanitizeUrl(url)}:\n  ${trail.join("\n  ")}\n` +
      `hint: if the target serves a raw spec (OpenAPI, AsyncAPI, ...), pass the spec document's own URL`,
  );
}

function defaultFetch(): typeof globalThis.fetch {
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis);
  }
  return (() => Promise.reject(new Error(
    "openbindings: fetch is not available — provide a fetch implementation via FetchInterfaceOptions",
  )));
}

/**
 * Caps how much of a fetched interface document is read (1 MiB — matched
 * byte-for-byte by the Go SDK). Exceeding it is a loud error, never a
 * truncation that would surface as a confusing parse failure.
 */
const MAX_FETCH_BYTES = 1 << 20;

async function readCapped(resp: Response): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) {
    // No streaming body (some fetch polyfills): buffer, then check.
    const text = await resp.text();
    if (new TextEncoder().encode(text).length > MAX_FETCH_BYTES) {
      throw new Error(`openbindings: interface document exceeds the ${MAX_FETCH_BYTES}-byte fetch cap`);
    }
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_FETCH_BYTES) {
      await reader.cancel();
      throw new Error(`openbindings: interface document exceeds the ${MAX_FETCH_BYTES}-byte fetch cap`);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(buf);
}

/**
 * One step in the resolution chain. `iface` is set only on a hit; `result` is
 * a one-line summary for the failure trail: the error, an `HTTP <status>`, "not
 * an OBI" (reachable JSON that is not an OBI document), or "ok".
 */
interface FetchStep {
  iface: OBInterface | null;
  result: string;
}

async function tryFetchOBI(
  fetchFn: typeof globalThis.fetch,
  url: string,
  signal?: AbortSignal,
): Promise<FetchStep> {
  let resp: Response;
  try {
    resp = await fetchFn(url, {
      signal,
      headers: { Accept: "application/vnd.openbindings+json, application/json" },
    });
  } catch (e) {
    return { iface: null, result: errText(e) };
  }
  if (!resp.ok) return { iface: null, result: `HTTP ${resp.status}` };
  let text: string;
  try {
    text = await readCapped(resp);
  } catch (e) {
    return { iface: null, result: errText(e) };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (e) {
    // A parse error is a real failure, not "not an OBI" (which is reserved
    // for reachable JSON that simply isn't an OBI document) — mirrors Go.
    return { iface: null, result: errText(e) };
  }
  if (isOBInterface(body)) return { iface: parseDocument(text), result: "ok" };
  return { iface: null, result: "not an OBI" };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Strips a query string for user-facing messages (mirrors Go's sanitizeURL). */
function sanitizeUrl(u: string): string {
  const idx = u.indexOf("?");
  return idx >= 0 ? u.slice(0, idx) : u;
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

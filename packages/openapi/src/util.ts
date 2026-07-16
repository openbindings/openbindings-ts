import type { OpenAPIDocument, OpenAPIParameter } from "./types.js";
import { VALID_METHODS } from "./constants.js";
import { dereference } from "@openbindings/sdk";
import yaml from "js-yaml";

const NON_KEY_CHARS = /[^a-zA-Z0-9._-]/g;

/** Replaces non-alphanumeric characters in a name with underscores to produce a valid key. */
export function sanitizeKey(name: string): string {
  const key = name.replace(NON_KEY_CHARS, "_").replace(/^_+|_+$/g, "");
  return key || "unnamed";
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
  const [escapedPath, method] = parts;
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
 * discriminates the accepted lines (OAPI-P-01).
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
  options?: { signal?: AbortSignal; allowExternalRefs?: boolean },
  fetchFn?: typeof globalThis.fetch,
): Promise<OpenAPIDocument> {
  // `location`, when present, must be an absolute URI (OAPI-D-02) —
  // whether it is the fetch target or only the embedded content's base.
  // A bare filesystem path is refused loudly before any fetch (the Go
  // loader's posture; the former "local tooling" lenience is gone).
  if (location) validateDocumentAddress(location);

  let raw: unknown;
  if (content != null) {
    if (typeof content === "string") raw = parseJSONOrYAML(content);
    else if (typeof content === "object") raw = content;
    else raw = structuredClone(content);
  } else {
    if (!location) {
      throw new Error("source must have location or content");
    }

    const doFetch = fetchFn ?? fetch;
    const resp = await doFetch(location, { signal: options?.signal });
    if (!resp.ok) {
      throw new Error(`failed to fetch ${location}: ${resp.status} ${resp.statusText}`);
    }

    let text: string;
    try {
      text = await resp.text();
    } catch (e: unknown) {
      throw new Error(`failed to read response body from ${location}: ${errorMessage(e)}`);
    }

    try {
      raw = parseJSONOrYAML(text);
    } catch {
      const preview = text.length > 120 ? text.slice(0, 120) + "..." : text;
      throw new Error(`failed to parse response from ${location}: ${preview}`);
    }
  }

  checkAcceptedOpenAPIVersion(raw);

  const allowExternalRefs = options?.allowExternalRefs ?? true;
  let refFetch: typeof globalThis.fetch;
  if (!allowExternalRefs) {
    refFetch = blockExternalRefFetch;
  } else if (!location && content != null) {
    refFetch = selfContainedRefFetch(fetchFn ?? fetch);
  } else {
    refFetch = fetchFn ?? fetch;
  }
  return dereference<OpenAPIDocument>(raw as Record<string, unknown>, {
    baseUrl: location,
    parse: parseJSONOrYAML,
    signal: options?.signal,
    fetch: refFetch,
  });
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
 * Discriminates the accepted lines per OAPI-P-01: the artifact's own
 * `openapi` field must declare 3.0.* or 3.1.*; any other value — a Swagger
 * 2.0 `swagger` field included — is refused loudly at load.
 */
function checkAcceptedOpenAPIVersion(raw: unknown): void {
  const doc = raw as Record<string, unknown> | null;
  const v = doc && typeof doc === "object" ? doc["openapi"] : undefined;
  if (typeof v !== "string" || v === "") {
    throw new Error(
      "document declares no `openapi` field: openbindings.openapi@1 accepts OpenAPI 3.0.x and 3.1.x documents only (OAPI-P-01; Swagger 2.0 is not accepted)",
    );
  }
  const parts = v.split(".");
  const mm = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : v;
  if (mm !== "3.0" && mm !== "3.1") {
    throw new Error(
      `unsupported OpenAPI version "${v}": openbindings.openapi@1 accepts the 3.0.x and 3.1.x lines only (OAPI-P-01)`,
    );
  }
}

/**
 * Rejects any external `$ref` fetch. Used to keep a content-only document
 * parse side-effect-free (Go parity: `prepareBinding`'s content path never
 * touches the network — internal `#/...` refs still resolve locally).
 */
const blockExternalRefFetch: typeof globalThis.fetch = (() => {
  throw new Error("external $ref resolution is disabled for this load");
}) as unknown as typeof globalThis.fetch;

/**
 * Allows absolute http(s) reference targets (they resolve without a base)
 * and refuses everything else: with no co-present location the embedded
 * artifact has no base URI, so a relative reference is unresolvable by
 * definition (§6 — bundle before embedding).
 */
function selfContainedRefFetch(real: typeof globalThis.fetch): typeof globalThis.fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return real(input, init);
    }
    throw new Error(
      `reference "${url}" cannot resolve: embedded content with no co-present location has no base URI and must be self-contained (bundle the document before embedding, or set the source's location)`,
    );
  }) as typeof globalThis.fetch;
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

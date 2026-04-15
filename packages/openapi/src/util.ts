import type { OpenAPIDocument, OpenAPIParameter } from "./types.js";
import { VALID_METHODS } from "./constants.js";
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

/** Parses a JSON Pointer ref (e.g. #/paths/~1users/get) into its path and HTTP method components. */
export function parseRef(ref: string): { path: string; method: string } {
  ref = ref.replace(/^#\//, "");
  const parts = ref.split("/");
  if (parts.length < 3 || parts[0] !== "paths") {
    throw new Error(`ref "${ref}" must be in format #/paths/<escaped-path>/<method>`);
  }

  const method = parts[parts.length - 1].toLowerCase();
  const escapedPath = parts.slice(1, -1).join("/");
  const path = escapedPath.replaceAll("~1", "/").replaceAll("~0", "~");

  if (!VALID_METHODS.has(method)) {
    throw new Error(`invalid HTTP method "${method}" in ref`);
  }

  return { path, method };
}

/** Builds a JSON Pointer ref string from a path and HTTP method, escaping special characters. */
export function buildJsonPointerRef(path: string, method: string): string {
  const escaped = path.replaceAll("~", "~0").replaceAll("/", "~1");
  return `#/paths/${escaped}/${method.toLowerCase()}`;
}

/** Loads and parses an OpenAPI document from a URL location or inline content (JSON or YAML). */
export async function loadOpenAPIDocument(
  location?: string,
  content?: unknown,
  options?: { signal?: AbortSignal },
  fetchFn?: typeof globalThis.fetch,
): Promise<OpenAPIDocument> {
  if (content != null) {
    if (typeof content === "string") return parseJSONOrYAML(content) as OpenAPIDocument;
    if (typeof content === "object") return content as OpenAPIDocument;
    return JSON.parse(JSON.stringify(content)) as OpenAPIDocument;
  }
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
    return parseJSONOrYAML(text) as OpenAPIDocument;
  } catch {
    const preview = text.length > 120 ? text.slice(0, 120) + "..." : text;
    throw new Error(`failed to parse response from ${location}: ${preview}`);
  }
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

function parseJSONOrYAML(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  return yaml.load(trimmed);
}

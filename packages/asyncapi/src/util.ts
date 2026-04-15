import yaml from "js-yaml";
import { dereference } from "@openbindings/sdk";

import type { AsyncAPIDocument } from "./asyncapi-types.js";

const NON_KEY_CHARS = /[^a-zA-Z0-9._-]/g;

/** Replaces non-alphanumeric characters with underscores to produce a valid key. */
export function sanitizeKey(name: string): string {
  const key = name.replace(NON_KEY_CHARS, "_").replace(/^_+|_+$/g, "");
  return key || "unnamed";
}

/** Returns a unique variant of `key` by appending a numeric suffix if it already exists in `used`. */
export function uniqueKey(key: string, used: Set<string>): string {
  if (!used.has(key)) return key;
  for (let i = 2; ; i++) {
    const candidate = `${key}_${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Fetches (if needed) and parses an AsyncAPI document from a location URL or inline content. */
export async function parseAsyncAPIDocument(
  location?: string,
  content?: unknown,
  options?: { signal?: AbortSignal },
  fetchFn?: typeof globalThis.fetch,
): Promise<AsyncAPIDocument> {
  let raw: unknown;

  if (content != null) {
    if (typeof content === "string") {
      raw = yaml.load(content);
    } else {
      raw = content;
    }
  } else if (location) {
    const doFetch = fetchFn ?? fetch;
    const resp = await doFetch(location, { signal: options?.signal });
    if (!resp.ok) {
      throw new Error(`failed to fetch ${location}: ${resp.status} ${resp.statusText}`);
    }
    const text = await resp.text();
    raw = yaml.load(text);
  } else {
    throw new Error("source must have location or content");
  }

  // Resolve all $ref pointers.
  const resolved = (await dereference(raw as Record<string, unknown>, {
    baseUrl: location,
    parse: (text) => yaml.load(text) as Record<string, unknown>,
    signal: options?.signal,
  })) as unknown as AsyncAPIDocument;

  if (!resolved.asyncapi) {
    throw new Error("not a valid AsyncAPI document (missing 'asyncapi' field)");
  }

  return resolved;
}

/** Extracts the operation ID from a `#/operations/<id>` ref string, or returns the ref as-is. */
export function parseRef(ref: string): string {
  ref = ref.trim();
  if (!ref) throw new Error("empty ref");

  const prefix = "#/operations/";
  if (ref.startsWith(prefix)) {
    const opID = ref.slice(prefix.length);
    if (!opID) throw new Error(`empty operation ID in ref "${ref}"`);
    return opID;
  }

  return ref;
}

/** Extracts a human-readable message from an unknown thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

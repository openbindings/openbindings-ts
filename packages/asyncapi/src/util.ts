import yaml from "js-yaml";
import { dereference } from "@openbindings/sdk";

import type { AsyncAPIDocument } from "./asyncapi-types.js";
import { CHANNEL_NAME_TAG, REF_NAME_TAG, SERVER_NAME_TAG } from "./constants.js";

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

const SECURITY_SCHEME_REF_PREFIX = "#/components/securitySchemes/";

/**
 * Tags each internal `$ref`-only entry of one `security` list with the
 * components.securitySchemes key it points to (rule A's `name`), under
 * {@link REF_NAME_TAG} — a field the shared dereferencer's merge-copy path
 * carries onto the resolved scheme object (extra keys on a `$ref` node are
 * copied onto the target when the target doesn't already have them). Left
 * untouched: an inline scheme (no `$ref` — no addressable name to tag), a
 * `$ref` elsewhere in the document (channel/message $refs are unaffected —
 * only entries of a `security` array are visited), and an external or
 * non-securitySchemes-local `$ref` (no LOCAL components.securitySchemes key
 * exists for it).
 */
function tagSecurityRefNames(list: unknown): void {
  if (!Array.isArray(list)) return;
  for (const entry of list) {
    if (entry == null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.$ref !== "string" || !e.$ref.startsWith(SECURITY_SCHEME_REF_PREFIX)) continue;
    e[REF_NAME_TAG] = e.$ref.slice(SECURITY_SCHEME_REF_PREFIX.length);
  }
}

/**
 * Applies {@link tagSecurityRefNames} to every `security` list in the raw
 * (pre-dereference) document: each operation's and each server's. Mirrors
 * tagNameKeys' shape — a targeted pass over the RAW document before the
 * generic dereferencer runs.
 */
function tagAllSecurityRefNames(raw: unknown): void {
  if (raw == null || typeof raw !== "object") return;
  const doc = raw as Record<string, unknown>;
  const operations = doc.operations;
  if (operations != null && typeof operations === "object") {
    for (const op of Object.values(operations as Record<string, unknown>)) {
      if (op != null && typeof op === "object") {
        tagSecurityRefNames((op as Record<string, unknown>).security);
      }
    }
  }
  const servers = doc.servers;
  if (servers != null && typeof servers === "object") {
    for (const server of Object.values(servers as Record<string, unknown>)) {
      if (server != null && typeof server === "object") {
        tagSecurityRefNames((server as Record<string, unknown>).security);
      }
    }
  }
}

/**
 * Tags each entry of a raw top-level map (`channels`, `servers`) with its
 * own map key under `tag`, so the key survives dereferencing: an
 * operation's channel `$ref` and a channel's `servers` subset entries
 * resolve to clones of these tagged objects, and the invoke path reads the
 * name back off the resolved object (target.ts's channelNameOf /
 * serverNameOf). The tag rides the TARGET object — the name is the entry's
 * own map key, a property of the target, not of any one reference.
 */
function tagNameKeys(raw: unknown, mapField: string, tag: string): void {
  if (raw == null || typeof raw !== "object") return;
  const map = (raw as Record<string, unknown>)[mapField];
  if (map == null || typeof map !== "object") return;
  for (const [name, entry] of Object.entries(map as Record<string, unknown>)) {
    if (entry == null || typeof entry !== "object") continue;
    (entry as Record<string, unknown>)[tag] = name;
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

  tagNameKeys(raw, "channels", CHANNEL_NAME_TAG);
  tagNameKeys(raw, "servers", SERVER_NAME_TAG);
  tagAllSecurityRefNames(raw);

  // Resolve all $ref pointers. External $refs fetch through the injected
  // fetch (callers that must stay side-effect-free inject a rejecting one).
  const resolved = (await dereference(raw as Record<string, unknown>, {
    baseUrl: location,
    fetch: fetchFn,
    parse: (text) => yaml.load(text) as Record<string, unknown>,
    signal: options?.signal,
  })) as unknown as AsyncAPIDocument;

  if (!resolved.asyncapi) {
    throw new Error("not a valid AsyncAPI document (missing 'asyncapi' field)");
  }
  // Per spec/binding-specs/asyncapi (ASYNC-P-01): AsyncAPI 2.x documents
  // are out of the supported range and refused loudly at load, mirroring
  // the Go SDK's loadDocument (which requires a "3." prefix).
  if (!resolved.asyncapi.startsWith("3.")) {
    throw new Error(`unsupported AsyncAPI version "${resolved.asyncapi}" (expected 3.x)`);
  }

  return resolved;
}

/**
 * Extracts the operation key from a `#/operations/<key>` ref string, or
 * returns the ref as-is (a pre-existing lenience, pinned by test). Keys
 * containing `/` or `~` carry RFC 6901 escaping in the pointer
 * (ASYNC-D-03): `~1` → `/`, `~0` → `~`, in that order.
 */
export function parseRef(ref: string): string {
  ref = ref.trim();
  if (!ref) throw new Error("empty ref");

  const prefix = "#/operations/";
  if (ref.startsWith(prefix)) {
    const opID = ref.slice(prefix.length);
    if (!opID) throw new Error(`empty operation ID in ref "${ref}"`);
    return opID.replaceAll("~1", "/").replaceAll("~0", "~");
  }

  return ref;
}

/** Extracts a human-readable message from an unknown thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

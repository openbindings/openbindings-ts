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
    // `location` must be an absolute URI (ASYNC-D-02) — a bare filesystem
    // path is refused loudly before any fetch is attempted.
    validateDocumentAddress(location);
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
  // ASYNC-P-01: the artifact's own `asyncapi` field discriminates the
  // accepted line — 3.0.x ONLY. A later 3.x line is adopted by compatible
  // revision of the binding specification, never sight-unseen.
  if (!resolved.asyncapi.startsWith("3.0.")) {
    throw new Error(
      `unsupported AsyncAPI version "${resolved.asyncapi}": openbindings.asyncapi@1 accepts the 3.0.x line only (ASYNC-P-01)`,
    );
  }

  return resolved;
}

/**
 * Checks ASYNC-D-02's location grammar offline, without dereferencing:
 * `location`, when present, is an absolute URI addressing the AsyncAPI
 * document itself. A bare filesystem path is a relative reference in form
 * (core OBI-D-05) and is refused — a local artifact is addressed as
 * file:// or embedded as the source's content.
 */
export function validateDocumentAddress(location: string): void {
  try {
    new URL(location);
  } catch {
    throw new Error(
      `asyncapi location ${JSON.stringify(location)} is not an absolute URI addressing the document (ASYNC-D-02): a local artifact is addressed as file:// or embedded as the source's content`,
    );
  }
}

/**
 * Parses a binding ref per ASYNC-D-03: a JSON Pointer
 * `#/operations/<operation-key>` addressing an operations-map entry is the
 * ONLY conformant spelling. A bare operation key without the pointer
 * prefix is refused (the former lenience is gone), and an unescaped `/`
 * after the prefix addresses a deeper path — never an operations-map
 * entry — so it is refused too. Operation keys containing `/` or `~` carry
 * RFC 6901 escaping in the pointer: `~1` → `/`, `~0` → `~`, decoded in
 * that order.
 */
export function parseRef(ref: string): string {
  ref = ref.trim();
  if (!ref) {
    throw new Error("ref is required and must be a JSON Pointer #/operations/<operation-key> (ASYNC-D-03)");
  }

  const prefix = "#/operations/";
  if (!ref.startsWith(prefix)) {
    throw new Error(
      `ref "${ref}" is not a JSON Pointer #/operations/<operation-key>: the pointer is the only conformant spelling — a bare operation key is not accepted (ASYNC-D-03)`,
    );
  }
  const token = ref.slice(prefix.length);
  if (!token) throw new Error(`empty operation key in ref "${ref}" (ASYNC-D-03)`);
  if (token.includes("/")) {
    throw new Error(
      `ref "${ref}" addresses a deeper path, not an operations-map entry: an operation key containing / carries RFC 6901 escaping (~1) (ASYNC-D-03)`,
    );
  }
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

/**
 * Builds the conformant ASYNC-D-03 spelling for an operation key:
 * `#/operations/` + the RFC 6901-escaped key (`~` → `~0` first, then
 * `/` → `~1` — escape order is the reverse of decode order).
 */
export function operationRef(opID: string): string {
  return `#/operations/${opID.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

/** Extracts a human-readable message from an unknown thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

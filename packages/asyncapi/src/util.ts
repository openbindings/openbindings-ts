export {
  operationRef,
  parseRef,
  rawParsedDocument,
  validateDocumentAddress,
} from "@openbindings/asyncapi-client/analysis";
import { parseAsyncAPIDocument as parseArtifactDocument } from "@openbindings/asyncapi-client/analysis";

/** Adds the OpenBindings rule identity around the standalone artifact parser. */
export async function parseAsyncAPIDocument(
  location?: string,
  content?: unknown,
  options?: { signal?: AbortSignal },
  fetchFn?: typeof globalThis.fetch,
) {
  try {
    return await parseArtifactDocument(location, content, options, fetchFn);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("unsupported AsyncAPI version")) {
      throw new Error(`${message} (ASYNC-P-01)`, { cause: error });
    }
    throw error;
  }
}

// The u flag makes the class match whole code points, so an astral-plane
// character replaces as one underscore, matching Go's rune-based regexp.
const NON_KEY_CHARS = /[^a-zA-Z0-9._-]/gu;

/** Replaces non-alphanumeric characters with underscores to produce a valid key. */
export function sanitizeKey(name: string): string {
  const key = name.replace(NON_KEY_CHARS, "_").replace(/^_+|_+$/g, "");
  if (!key) return "unnamed";
  return /^[A-Za-z_]/.test(key) ? key : `_${key}`;
}

/** Returns a unique variant of `key` by appending a numeric suffix if needed. */
export function uniqueKey(key: string, used: Set<string>): string {
  if (!used.has(key)) return key;
  for (let i = 2; ; i += 1) {
    const candidate = `${key}_${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Stable Unicode-code-point ordering shared with Go's UTF-8 byte ordering. */
export function codePointCompare(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(i) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

/** Extracts a human-readable message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

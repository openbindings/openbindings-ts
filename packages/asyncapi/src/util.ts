export {
  parseAsyncAPIDocument,
  validateDocumentAddress,
} from "@openbindings/asyncapi-client/analysis";

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

/** Parses ASYNC-D-03's exact operation JSON Pointer spelling. */
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

/** Builds ASYNC-D-03's exact RFC 6901-escaped operation pointer. */
export function operationRef(opID: string): string {
  return `#/operations/${opID.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

/** Extracts a human-readable message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

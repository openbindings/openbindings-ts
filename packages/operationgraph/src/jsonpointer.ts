/**
 * Binding ref resolution. Per the format spec, a ref MUST be a JSON Pointer
 * (RFC 6901) fragment: a leading "#" followed by a Pointer. "#" alone
 * resolves to the whole document; bare graph keys are not accepted.
 */

/**
 * A ref resolution failure; `invalid` distinguishes malformed refs
 * (ERR_INVALID_REF) from well-formed Pointers that miss (ERR_REF_NOT_FOUND).
 */
export class RefError extends Error {
  readonly invalid: boolean;
  constructor(message: string, invalid = false) {
    super(message);
    this.name = "RefError";
    this.invalid = invalid;
  }
}

/** Resolves a JSON Pointer fragment ref against a parsed document. */
export function resolveRef(doc: unknown, ref: string): unknown {
  if (!ref.startsWith("#")) {
    throw new RefError(
      `ref "${ref}" is not a JSON Pointer fragment (must start with '#'; bare graph keys are not accepted)`,
      true,
    );
  }
  const pointer = ref.slice(1);
  if (pointer === "") return doc;
  if (!pointer.startsWith("/")) {
    throw new RefError(
      `ref "${ref}" carries a malformed JSON Pointer (must be empty or start with '/')`,
      true,
    );
  }
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(cur)) {
      const idx = Number(token);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) {
        throw new RefError(`ref "${ref}" does not resolve: bad array index "${token}"`);
      }
      cur = cur[idx];
    } else if (typeof cur === "object" && cur !== null) {
      const obj = cur as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(obj, token)) {
        throw new RefError(`ref "${ref}" does not resolve: no member "${token}"`);
      }
      cur = obj[token];
    } else {
      throw new RefError(`ref "${ref}" does not resolve: "${token}" addresses into a non-container`);
    }
  }
  return cur;
}

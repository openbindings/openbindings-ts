/**
 * Binding selector resolution. Per the format spec, a selector MUST be a JSON Pointer
 * (RFC 6901) fragment: a leading "#" followed by a Pointer. "#" alone
 * resolves to the whole document; bare graph keys are not accepted.
 */

/**
 * A selector resolution failure; `invalid` distinguishes malformed selectors
 * (ERR_INVALID_SELECTOR) from well-formed Pointers that miss (ERR_SELECTOR_NOT_FOUND).
 */
export class SelectorError extends Error {
  readonly invalid: boolean;
  constructor(message: string, invalid = false) {
    super(message);
    this.name = "SelectorError";
    this.invalid = invalid;
  }
}

/** Resolves a JSON Pointer fragment selector against a parsed document. */
export function resolveSelector(doc: unknown, selector: string): unknown {
  if (!selector.startsWith("#")) {
    throw new SelectorError(
      `selector "${selector}" is not a JSON Pointer fragment (must start with '#'; bare graph keys are not accepted)`,
      true,
    );
  }
  const pointer = selector.slice(1);
  if (pointer === "") return doc;
  if (!pointer.startsWith("/")) {
    throw new SelectorError(
      `selector "${selector}" carries a malformed JSON Pointer (must be empty or start with '/')`,
      true,
    );
  }
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(cur)) {
      const idx = Number(token);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) {
        throw new SelectorError(`selector "${selector}" does not resolve: bad array index "${token}"`);
      }
      cur = cur[idx];
    } else if (typeof cur === "object" && cur !== null) {
      const obj = cur as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(obj, token)) {
        throw new SelectorError(`selector "${selector}" does not resolve: no member "${token}"`);
      }
      cur = obj[token];
    } else {
      throw new SelectorError(`selector "${selector}" does not resolve: "${token}" addresses into a non-container`);
    }
  }
  return cur;
}

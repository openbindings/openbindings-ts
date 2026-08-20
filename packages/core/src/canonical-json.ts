import rawCanonicalize from "canonicalize";

/**
 * Serializes a JSON value to its canonical form per RFC 8785 (JSON
 * Canonicalization Scheme, JCS): deterministic object-key ordering and number
 * formatting. This is the SDK's first-party helper over the `canonicalize`
 * library; it underlies the schema-comparison profile's detail strings and the
 * delegate-registry content hash, mirroring Go's `canonicaljson.Marshal`.
 *
 * Returns `undefined` for input the JCS cannot represent (for example a bare
 * `undefined`), matching the underlying library.
 */
export function canonicalize(value: unknown): string | undefined {
  return rawCanonicalize(value);
}

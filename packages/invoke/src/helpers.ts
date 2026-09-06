/**
 * Reports whether a Content-Type header declares a JSON body:
 * application/json or any +json structured-suffix type. Absent or
 * unparseable → NOT JSON. This is wire framing (the header decides the
 * decode lane), never payload sniffing — the pinned decode rule of the
 * conventions record's recommended built-in defaults
 * (spec/binding-specs/README.md).
 * (Replaces the removed `maybeJSON` payload sniffer: content-dependent
 * defaults are banned; a wrong lane must fail loudly or be elected
 * explicitly, never guessed from the bytes.)
 */
export function isJSONContentType(
  contentType: string | null | undefined,
): boolean {
  if (!contentType) return false;
  let mt = contentType.trim().toLowerCase();
  const semi = mt.indexOf(";");
  if (semi >= 0) mt = mt.slice(0, semi).trim();
  return mt === "application/json" || mt.endsWith("+json");
}

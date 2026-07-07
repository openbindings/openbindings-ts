/**
 * Extracts the lowercase name portion from a format token.
 * "openapi@3.1" → "openapi"
 */
export function formatName(token: string): string {
  const at = token.lastIndexOf("@");
  if (at <= 0) return token.trim().toLowerCase();
  return token.slice(0, at).toLowerCase();
}

/**
 * Reports whether a Content-Type header declares a JSON body:
 * application/json or any +json structured-suffix type. Absent or
 * unparseable → NOT JSON. This is wire framing (the header decides the
 * decode lane), never payload sniffing — the §6 pinned decode rule.
 * (Replaces the removed `maybeJSON` payload sniffer: content-dependent
 * defaults are banned; a wrong lane must fail loudly or be elected
 * explicitly, never guessed from the bytes.)
 */
export function isJSONContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  let mt = contentType.trim().toLowerCase();
  const semi = mt.indexOf(";");
  if (semi >= 0) mt = mt.slice(0, semi).trim();
  return mt === "application/json" || mt.endsWith("+json");
}

/**
 * Extracts a normalized major.minor version from a full version string.
 * "3.1.0" → "3.1"
 */
export function detectFormatVersion(version: string): string {
  const parts = version.split(".");
  if (parts.length >= 2) return `${parts[0]}.${parts[1]}`;
  return version;
}

/** Returns true if `s` starts with http:// or https://. */
export function isHttpUrl(s: string): boolean {
  return s.startsWith("http://") || s.startsWith("https://");
}

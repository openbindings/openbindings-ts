/**
 * Extracts the lowercase name portion from a format token.
 * "openapi@3.1" → "openapi"
 */
export function formatName(token: string): string {
  const at = token.lastIndexOf("@");
  if (at <= 0) return token.trim().toLowerCase();
  return token.slice(0, at).toLowerCase();
}

/** Returns true if the trimmed string looks like a JSON object or array. */
export function maybeJSON(s: string): boolean {
  const t = s.trim();
  return (
    (t.startsWith("{") && t.endsWith("}")) ||
    (t.startsWith("[") && t.endsWith("]"))
  );
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

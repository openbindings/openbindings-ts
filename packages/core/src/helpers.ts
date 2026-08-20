/** Returns true if `s` starts with http:// or https://. */
export function isHttpUrl(s: string): boolean {
  return s.startsWith("http://") || s.startsWith("https://");
}

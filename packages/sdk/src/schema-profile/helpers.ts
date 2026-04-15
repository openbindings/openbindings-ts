import canonicalize from "canonicalize";

export type JSONValue = unknown;
export type JSONObject = Record<string, unknown>;

export function asMap(v: JSONValue): JSONObject | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as JSONObject;
  return null;
}

export function asSlice(v: JSONValue): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

export function pathOrRoot(path: string): string {
  return path || "<root>";
}

export function ptrJoin(prefix: string, next: string): string {
  if (!prefix) return next;
  if (!next) return prefix;
  if (next.startsWith("[") || next.startsWith(".")) return prefix + next;
  return `${prefix}.${next}`;
}

export function canonicalKey(v: JSONValue): string {
  return canonicalize(v) ?? "<unserializable>";
}

export function toFloat64(v: JSONValue): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

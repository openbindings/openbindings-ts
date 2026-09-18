import { isDecimal, isEncoded, isNumber, stringify, compareNumberTokens, JSONValueSet } from "@openbindings/json";

export type JSONValue = unknown;
export type JSONObject = Record<string, unknown>;

export function asMap(v: JSONValue): JSONObject | null {
  if (v && typeof v === "object" && !Array.isArray(v) && !isDecimal(v) && !isEncoded(v)) return v as JSONObject;
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

/** Diagnostic rendering only. Never use these bytes as value identity. */
export function renderValue(v: JSONValue): string {
  // Property names and native scalars have no opaque children or hooks.
  if (v === null || typeof v === "string" || typeof v === "boolean"
    || (typeof v === "number" && Number.isFinite(v))) return JSON.stringify(v);
  const ordered = (x: unknown): unknown => Array.isArray(x) ? x.map(ordered)
    : asMap(x) ? Object.fromEntries(Object.keys(x as JSONObject).sort().map(k => [k, ordered((x as JSONObject)[k])])) : x;
  return stringify(ordered(v) as never);
}

export function numericToken(v: JSONValue): string {
  const token = isNumber(v) ? String(v) : undefined;
  if (token === undefined) throw new TypeError("Schema bound must be a JSON number");
  return token;
}

export const compareNumeric = (a: unknown, b: unknown): number => compareNumberTokens(numericToken(a), numericToken(b));

/** Instance-value set retaining first-authored order, including its spelling. */
export class ValueSet extends JSONValueSet {}

import { cloneJSON, equalJSON, numberToken, type JSONValue } from "./index.js";
import { numberIndexKey } from "./number.js";

/** Owned, first-insertion-ordered JSON values. Private lookup keys only narrow
 * exact comparisons. They are not canonical JSON or persistent identities.
 * Numeric indexing uses the existing numeric-predicate work budget. */
export class JSONValueSet implements Iterable<JSONValue> {
  private readonly buckets = new Map<string, JSONValue>();
  private collisions?: Map<string, JSONValue[]>;
  private readonly ordered: JSONValue[] = [];
  private key = valueIndexKey;
  constructor(values: readonly unknown[] = []) { for (const value of values) this.add(value); }
  get size(): number { return this.ordered.length; }
  add(value: unknown): boolean {
    const owned = cloneJSON(value), key = this.key(owned), prior = this.buckets.get(key);
    if (prior === undefined) this.buckets.set(key, owned);
    else {
      if (sameOwnedValue(prior, owned)) return false;
      const rest = this.collisions?.get(key) ?? [];
      if (rest.some(item => sameOwnedValue(item, owned))) return false;
      rest.push(owned); (this.collisions ??= new Map()).set(key, rest);
    }
    this.ordered.push(owned); return true;
  }
  has(value: unknown): boolean {
    const owned = cloneJSON(value), key = this.key(owned), prior = this.buckets.get(key);
    return prior !== undefined && (sameOwnedValue(prior, owned)
      || (this.collisions?.get(key)?.some(item => sameOwnedValue(item, owned)) ?? false));
  }
  *[Symbol.iterator](): Iterator<JSONValue> { for (const value of this.ordered) yield cloneJSON(value); }
}

function sameOwnedValue(a: JSONValue, b: JSONValue): boolean {
  // Both operands already passed cloneJSON admission and index work checks.
  // Native scalar identity is exact; opaque numbers still use the predicate.
  return (typeof a !== "object" && a === b) || equalJSON(a, b);
}

function valueIndexKey(value: JSONValue): string {
  if (typeof value === "number") return "n" + String(value);
  const token = numberToken(value);
  if (token !== undefined) return numberIndexKey(token);
  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") return "s" + JSON.stringify(value);
  const framed = (s: string): string => s.length + ":" + s;
  if (Array.isArray(value)) return "a" + value.map(v => framed(valueIndexKey(v))).join("");
  const record = value as Record<string, JSONValue>;
  return "o" + Object.keys(record).sort().map(k => framed(k) + framed(valueIndexKey(record[k]!))).join("");
}

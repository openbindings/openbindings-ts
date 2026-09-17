import { parseExact } from "./parse.js";
import stringify from "core-js-pure/actual/json/stringify.js";
import rawJSON from "core-js-pure/actual/json/raw-json.js";
import isRawJSON from "core-js-pure/actual/json/is-raw-json.js";
import { isNumber as isNumberTokenText } from "lossless-json";
import { compareNumberTokens } from "./number.js";

// ---------------------------------------------------------------------------
// The public surface (design/value-api-shape-loop/candidate/json.d.ts).
// Plain data with rich leaves: plain arrays and objects, primitives, and the
// two leaf classes Decimal and Encoded.
// ---------------------------------------------------------------------------
export { ValueError, type ValueErrorCode } from "./errors.js";
export { type ForcingReason, type Costs } from "./counters.js";
export {
  Decimal, Encoded, BASE64, type Encoding, type RawJSON, type Numeric, type Text,
  number, toNumber, isNumber, isDecimal, base64, encoded, isEncoded, bytes,
} from "./leaves.js";
export { parse, stringify, equal, plain, type Value, type Plain, type PlainOptions, type Limits, type ParseOptions } from "./codec.js";

// ---------------------------------------------------------------------------
// Retired surface. Every name below keeps working until Block 8 deletes it.
// The replacements live in the public surface above or in "./advanced".
// ---------------------------------------------------------------------------

// The deprecation notes for these six live on their declarations, so the
// built declaration files carry them: compareNumberTokens, integerNumberToken,
// multipleNumberTokens and JSONCapabilityError in number.ts, cloneValueGraph
// in graph.ts, JSONValueSet in value-set.ts.
export { compareNumberTokens, integerNumberToken, multipleNumberTokens, JSONCapabilityError } from "./number.js";
export { cloneValueGraph } from "./graph.js";
export { JSONValueSet } from "./value-set.js";

// RawJSON supplies authenticated, immutable cross-copy branding in the native
// runtime or the pinned pure compatibility implementation. The field alone is
// NEVER a brand. No global JSON methods or prototype are changed.
/** @deprecated Use `Decimal` (built by `number`, `parse` or admission). */
export class JSONNumber {
  declare readonly rawJSON: string;
  constructor(token: string) {
    if (!isNumberTokenText(token)) throw new TypeError("Invalid JSON number token");
    return rawJSON(token) as JSONNumber;
  }
  static [Symbol.hasInstance](value: unknown): boolean { return isJSONNumber(value); }
}

/** @deprecated Use `isDecimal`. */
export function isJSONNumber(value: unknown): value is JSONNumber {
  return isRawJSON(value) && isNumberTokenText((value as JSONNumber).rawJSON);
}

/** Exact token access. Native callers supply only the number they already own.
 * @deprecated Use `String(n)`: a number and a Decimal both print their digits. */
export function numberToken(value: unknown): string | undefined {
  return isJSONNumber(value) ? value.rawJSON
    : typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

/** @deprecated Use `equal`. */
export function equalJSON(a: unknown, b: unknown): boolean {
  assertJSONValue(a); assertJSONValue(b);
  return equalValue(a, b);
}
function equalValue(a: unknown, b: unknown): boolean {
  // Admission already checked native scalars. Identical native values cannot
  // gain precision from decimal work; opaque carriers still take that path.
  if (typeof a !== "object" && a === b) return true;
  const at = numberToken(a), bt = numberToken(b);
  if (at !== undefined || bt !== undefined) return at !== undefined && bt !== undefined && compareNumberTokens(at, bt) === 0;
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const aa = a as Record<string, unknown>, bb = b as Record<string, unknown>;
  const keys = Object.keys(aa);
  return keys.length === Object.keys(bb).length && keys.every(k => Object.hasOwn(bb, k) && equalValue(aa[k], bb[k]));
}

/** @deprecated Use `Value`. */
export type JSONValue = null | boolean | string | number | JSONNumber | JSONValue[] | {[key: string]: JSONValue};

/** Parse one JSON value without first reducing its numeric tokens. Boundary
 * owners retain their own duplicate, encoding, BOM and Unicode policies.
 * @deprecated Use `parse`, which applies the one number rule by value. */
export function parseJSON(text: string): JSONValue {
  return parseExact(text, value => value) as JSONValue;
}

/** Serialize actual JSON values. This does not invoke arbitrary toJSON hooks,
 * silently omit undefined members, or turn nonfinite numbers into null.
 * @deprecated Use `stringify`. */
export function stringifyJSON(value: unknown, space?: number | string): string {
  // Admitted native scalars have neither members nor serialization hooks.
  // Keep the same established serializer without allocating an object walk.
  if (isNativeJSONScalar(value)) return stringify(value, undefined, space)!;
  // JSON.stringify invokes toJSON BEFORE a replacer sees a value. Build a
  // descriptor-checked, hook-free image first; never hand caller objects to it.
  const text = stringify(walkJSON(value, new Set(), true), undefined, space);
  if (text === undefined) throw new TypeError("not a JSON value");
  return text;
}

/** @deprecated Results of the public surface are frozen and need no clone; `plain` gives a mutable primitive copy. */
export function cloneJSON(value: unknown): JSONValue {
  if (isNativeJSONScalar(value)) return value === 0 ? 0 : value;
  // Detachment is not a text boundary. Reuse the descriptor-checked walk
  // without serializing and parsing the entire graph a second time.
  return walkJSON(value, new Set(), true, false) as JSONValue;
}

/** @deprecated Admission is loud at every public entry; no assertion is needed. */
export function assertJSONValue(value: unknown): asserts value is JSONValue {
  if (isNativeJSONScalar(value)) return;
  walkJSON(value, new Set(), false);
}

function isNativeJSONScalar(value: unknown): value is null | boolean | string | number {
  return value === null || typeof value === "boolean" || typeof value === "string"
    || (typeof value === "number" && Number.isFinite(value));
}

function walkJSON(value: unknown, ancestors: Set<object>, materialize: boolean, forStringify = true): unknown {
  if (isJSONNumber(value)) return materialize ? (forStringify ? rawJSON(value.rawJSON) : value) : undefined;
  if (isRawJSON(value)) throw new TypeError("Unsupported nonnumeric RawJSON carrier");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value === 0 ? 0 : value;
  if (typeof value !== "object" || ancestors.has(value)) throw new TypeError("not a JSON value");
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new TypeError("not a JSON object");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      // JSON arrays have only ordered elements, not an extra metadata channel.
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
          throw new TypeError("not a JSON array member");
        }
      }
      const result: unknown[] = [];
      if (materialize && forStringify) Object.setPrototypeOf(result, null);
      for (let i=0;i<value.length;i++) {
        const d=Object.getOwnPropertyDescriptor(value,String(i));
        if (!d || !("value" in d)) throw new TypeError("not a JSON array element");
        const member = walkJSON(d.value,ancestors,materialize,forStringify);
        if (materialize) {
          if (forStringify) result[i] = member;
          else Object.defineProperty(result, i, {value: member, enumerable: true, configurable: true, writable: true});
        }
      }
      return materialize ? result : undefined;
    } else {
      const result = (forStringify ? Object.create(null) : {}) as Record<string, unknown>;
      for (const key of Reflect.ownKeys(value)) {
        const d=Object.getOwnPropertyDescriptor(value,key)!;
        if (typeof key!=="string" || !d.enumerable || !("value" in d)) throw new TypeError("not a JSON member");
        const member = walkJSON(d.value,ancestors,materialize,forStringify);
        if (materialize) {
          if (forStringify) result[key] = member;
          else Object.defineProperty(result, key, {value: member, enumerable: true, configurable: true, writable: true});
        }
      }
      return materialize ? result : undefined;
    }
  } finally { ancestors.delete(value); }
}

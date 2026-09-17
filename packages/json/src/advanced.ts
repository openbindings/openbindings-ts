import { charge } from "./counters.js";
/** The advanced entry: foreign storage, sizes, counters and exact comparison.
 * Ordinary tasks never import it. */
import { ValueError, admission } from "./errors.js";
import { work, counters, isForcingReason, type ForcingReason } from "./counters.js";
import { authenticate } from "./authenticate.js";
import {
  BASE64, Decimal, Encoded, byteView, codePointCount, copyEncodedInto, encoderOf, forceEncoded, isDecimal, isEncoded, isNumber, isNumberToken,
  isRawJSONToken, number, ownedEncoded, tokenOf, type Encoding, type Numeric,
} from "./leaves.js";
import { arrayKeys, budget, compareTokens, element, guarded, kindOf, measure, memberKeys, type Limits, type Size, type Value } from "./codec.js";

export type { Size } from "./codec.js";
export { counters };

export type ValueKind = "null" | "boolean" | "number" | "string" | "array" | "object";

/** An adapter-declared byte-backed string. Base64 identity is
 * `storage.encode === BASE64.encode`, and then `length` must be the Base64
 * length of `byteLength` bytes. */
export interface DeferredStringStorage {
  readonly byteLength: number;
  readonly length: number;
  readonly encode: (bytes: Uint8Array) => string;
  copyBytesInto(destination: Uint8Array): number;
}

/** A trusted host adapter over foreign storage. `deferredString` is
 * negotiated as an own data property only. */
export interface ValueAccess<T> {
  readonly version: 1;
  kind(value: T): ValueKind;
  get(value: T, key: string | number): T | undefined;
  keys(value: T): readonly string[];
  length(value: T): number | undefined;
  numberToken(value: T): string | undefined;
  scalar(value: T, reason?: ForcingReason): null | boolean | string | undefined;
  deferredString?(value: T): DeferredStringStorage | undefined;
}

/** The retained executors' Base64-only capabilities. Not part of the declared
 * adapter type; honoured when present as own data properties so an older
 * adapter still imports its byte-backed strings without encoding. */
interface LegacyByteAccess<T> {
  byteLength?(value: T): number | undefined;
  bytes?(value: T): Uint8Array | undefined;
  copyBytesInto?(value: T, destination: Uint8Array): number | undefined;
}

function ownFunction<F>(target: object, name: string): F | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  return descriptor && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "function" ? descriptor.value as F : undefined;
}

/** Run one adapter call; the adapter's own error becomes `cause`. */
function ask<R>(call: () => R, what: string, path: readonly string[]): R {
  try { return call(); }
  catch (cause) {
    if (cause instanceof ValueError) {
      if (cause.code === "ERR_JSON_ADMISSION" && cause.details?.path === undefined && path.length) throw admission(cause.message, path, cause);
      throw cause;
    }
    throw admission(`The value adapter failed in ${what}`, path, cause);
  }
}

/** Encodings reconstructed for foreign encoders, one per encoder identity, so
 * two imports of the same storage share an encoding object. The imported
 * length travels as data on the value; a reconstructed encoding cannot
 * measure other bytes and refuses rather than encode them. */
const foreignEncodings = new WeakMap<Encoding["encode"], Encoding>();
function encodingFor(encode: Encoding["encode"]): Encoding {
  if (encode === BASE64.encode) return BASE64;
  let encoding = foreignEncodings.get(encode);
  if (!encoding) {
    encoding = Object.freeze({
      length: (): number => { throw admission("An encoding imported through external carries its length as data on the value; it cannot measure other bytes"); },
      encode,
    });
    foreignEncodings.set(encode, encoding);
  }
  return encoding;
}

function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

/** A deeply frozen, authenticated Value snapshot of foreign storage. A leaf of
 * this installation met on the way is shared, not copied: it is immutable and
 * its identity (encoding, bytes, digits) is what a round trip must keep. */
export function external<T>(root: T, access: ValueAccess<T>, limits?: Limits): Value {
  if (access === null || typeof access !== "object" || access.version !== 1) throw admission("Unsupported value access version");
  const b = budget(limits), active = new Set<T>();
  const storage = ownFunction<NonNullable<ValueAccess<T>["deferredString"]>>(access, "deferredString");
  const legacy = access as ValueAccess<T> & LegacyByteAccess<T>;
  const legacyLength = ownFunction<NonNullable<LegacyByteAccess<T>["byteLength"]>>(access, "byteLength");
  const legacyCopy = ownFunction<NonNullable<LegacyByteAccess<T>["copyBytesInto"]>>(access, "copyBytesInto");
  const legacyBytes = ownFunction<NonNullable<LegacyByteAccess<T>["bytes"]>>(access, "bytes");

  function visit(value: T, depth: number, path: string[]): Value {
    b.visit(depth);
    charge("nodesRead");
    if (isDecimal(value)) { b.size(value.raw.rawJSON.length * 2); return value; }
    if (isEncoded(value)) { b.size(value.encoding === BASE64 ? value.byteLength : value.byteLength + value.length * 4); return value; }
    if (active.has(value)) throw admission("Cyclic value access", path);
    const kind = ask(() => access.kind(value), "kind", path);
    switch (kind) {
      case "number": {
        const token = ask(() => access.numberToken(value), "numberToken", path);
        if (!isNumberToken(token)) throw admission("Missing exact number token", path);
        b.size(token.length * 2);
        return number(token);
      }
      case "string": {
        const deferred = storage ? ask(() => storage.call(access, value), "deferredString", path) : undefined;
        if (deferred !== undefined) {
          if (deferred === null || typeof deferred !== "object") throw admission("Invalid deferred string storage", path);
          const { byteLength, length, encode } = deferred;
          if (!Number.isSafeInteger(byteLength) || byteLength < 0 || !Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(byteLength + length * 4)) {
            throw admission("Invalid deferred string size", path);
          }
          if (typeof encode !== "function" || typeof deferred.copyBytesInto !== "function") throw admission("Invalid deferred string storage", path);
          if (encode === BASE64.encode && length !== base64Length(byteLength)) throw admission("Base64 storage length contradicts the Base64 formula", path);
          b.size(encode === BASE64.encode ? byteLength : byteLength + length * 4);
          if (ask(() => access.length(value), "length", path) !== length) throw admission("Deferred string logical length mismatch", path);
          const destination = new Uint8Array(byteLength);
          const before = work.bytesCopied;
          const copied = ask(() => deferred.copyBytesInto(destination), "copyBytesInto", path);
          if (copied !== byteLength || byteView(destination, path).byteLength !== byteLength) throw admission("Deferred string copy length mismatch", path);
          // The sender charges when it is this installation; otherwise the receiver does.
          if (work.bytesCopied === before) charge("bytesCopied", byteLength);
          return ownedEncoded(destination, length, encodingFor(encode), encode);
        }
        const byteLength = legacyLength ? ask(() => legacyLength.call(legacy, value), "byteLength", path) : undefined;
        if (byteLength !== undefined) {
          if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw admission("Invalid byte length", path);
          b.size(byteLength);
          const length = base64Length(byteLength);
          if (ask(() => access.length(value), "length", path) !== length) throw admission("Byte logical length mismatch", path);
          const destination = new Uint8Array(byteLength);
          if (legacyCopy) {
            if (ask(() => legacyCopy.call(legacy, value, destination), "copyBytesInto", path) !== byteLength || byteView(destination, path).byteLength !== byteLength) {
              throw admission("Byte copy length mismatch", path);
            }
          } else {
            const source = legacyBytes ? ask(() => legacyBytes.call(legacy, value), "bytes", path) : undefined;
            if (source === undefined) throw admission("Missing byte storage", path);
            const view = byteView(source, path);
            if (view.byteLength !== byteLength) throw admission("Byte storage length mismatch", path);
            destination.set(view);
          }
          charge("bytesCopied", byteLength);
          return ownedEncoded(destination, length, BASE64, BASE64.encode);
        }
        const text = ask(() => access.scalar(value), "scalar", path);
        if (typeof text !== "string") throw admission("Value access scalar kind mismatch", path);
        b.size(text.length * 2);
        return text;
      }
      case "null": case "boolean": {
        const scalar = ask(() => access.scalar(value), "scalar", path);
        if (kind === "null" ? scalar !== null : typeof scalar !== "boolean") throw admission("Value access scalar kind mismatch", path);
        return scalar as null | boolean;
      }
      case "array": {
        const length = ask(() => access.length(value), "length", path);
        if (length === undefined || !Number.isSafeInteger(length) || length < 0) throw admission("Invalid array length", path);
        b.reserve(length);
        active.add(value);
        try {
          const items: Value[] = [];
          for (let i = 0; i < length; i++) {
            const child = ask(() => access.get(value, i), "get", path);
            path.push(String(i));
            if (child === undefined) throw admission("Missing array element", path);
            items.push(visit(child, depth + 1, path));
            path.pop();
          }
          authenticate(Object.freeze(items));
          return items;
        } finally { active.delete(value); }
      }
      case "object": {
        const keys = ask(() => access.keys(value), "keys", path);
        if (!Array.isArray(keys)) throw admission("Invalid object keys", path);
        b.reserve(keys.length);
        active.add(value);
        try {
          const out = Object.create(null) as Record<string, Value>;
          for (const key of keys) {
            if (typeof key !== "string" || Object.hasOwn(out, key)) throw admission("Invalid or duplicate object key", path);
            b.size(key.length * 2);
            const child = ask(() => access.get(value, key), "get", path);
            path.push(key);
            if (child === undefined) throw admission("Missing object member", path);
            out[key] = visit(child, depth + 1, path);
            path.pop();
          }
          Object.setPrototypeOf(out, Object.prototype);
          authenticate(Object.freeze(out));
          return out;
        } finally { active.delete(value); }
      }
      default: throw admission("Invalid logical value kind", path);
    }
  }
  const result = guarded(() => visit(root, 0, []));
  if (typeof result === "object" && result !== null && !isDecimal(result) && !isEncoded(result)) charge("treesBuilt");
  return result;
}

/** The genuine rawJSON token held by a Decimal of any installation: an object
 * whose only own key is `raw`, an enumerable data property holding a numeric
 * rawJSON token. Anything with more members is an object. */
function foreignDecimalToken(value: object): string | undefined {
  if (Array.isArray(value)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== "raw") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, "raw")!;
  if (!("value" in descriptor) || !descriptor.enumerable) return undefined;
  const raw: unknown = descriptor.value;
  return isRawJSONToken(raw) && isNumberToken(raw.rawJSON) ? raw.rawJSON : undefined;
}

const none: readonly string[] = [];

/** The adapter that reads plain data with rich leaves. */
export const access: ValueAccess<Value> = Object.freeze({
  version: 1 as const,
  kind(value: Value): ValueKind {
    if (typeof value === "object" && value !== null && !isDecimal(value) && !isEncoded(value) && foreignDecimalToken(value) !== undefined) return "number";
    switch (kindOf(value, none)) {
      case "decimal": return "number";
      case "encoded": return "string";
      case "null": return "null";
      case "boolean": return "boolean";
      case "number": return "number";
      case "string": return "string";
      case "array": return "array";
      default: return "object";
    }
  },
  get(value: Value, key: string | number): Value | undefined {
    if (Array.isArray(value)) {
      return typeof key === "number" && Number.isSafeInteger(key) && key >= 0 && key < value.length ? element(value, key, []) as Value : undefined;
    }
    if (typeof key !== "string" || typeof value !== "object" || value === null || isDecimal(value) || isEncoded(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && descriptor.enumerable && "value" in descriptor ? descriptor.value as Value : undefined;
  },
  keys(value: Value): readonly string[] {
    return typeof value === "object" && value !== null && !Array.isArray(value) && !isDecimal(value) && !isEncoded(value) ? memberKeys(value, []) : [];
  },
  length(value: Value): number | undefined {
    if (Array.isArray(value)) { arrayKeys(value, none); return value.length; }
    if (typeof value === "string") return codePointCount(value);
    return isEncoded(value) ? value.length : undefined;
  },
  numberToken(value: Value): string | undefined {
    if (typeof value === "number") return Number.isFinite(value) ? tokenOf(value) : undefined;
    if (isDecimal(value)) return value.raw.rawJSON;
    return typeof value === "object" && value !== null ? foreignDecimalToken(value) : undefined;
  },
  scalar(value: Value, reason?: ForcingReason): null | boolean | string | undefined {
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (!isEncoded(value)) return undefined;
    if (reason !== undefined && !isForcingReason(reason)) throw admission("Unknown string forcing reason");
    return forceEncoded(value, reason ?? "string-operation");
  },
  deferredString(value: Value): DeferredStringStorage | undefined {
    if (!isEncoded(value)) return undefined;
    return Object.freeze({
      byteLength: value.byteLength,
      length: value.length,
      encode: encoderOf(value),
      copyBytesInto: (destination: Uint8Array): number => copyEncodedInto(value, destination),
    });
  },
});

/** The Size of a value, for queue and admission accounting. */
export function sizeOf(value: Value, limits?: Limits): Size {
  return Object.freeze(guarded(() => measure(value, limits === undefined ? undefined : budget(limits), 0, [], new Set())));
}

/** -1, 0 or 1 by numeric value across number and Decimal. Identical operands
 * and identical digits compare without predicate work; otherwise the
 * predicate limits apply (ERR_JSON_BUDGET). */
export function compare(a: Numeric, b: Numeric): -1 | 0 | 1 {
  if (!isNumber(a) || !isNumber(b)) throw admission("compare expects two Numeric values");
  if (a === b) return 0;
  return compareTokens(tokenOf(a), tokenOf(b));
}

export type { Decimal, Encoded };

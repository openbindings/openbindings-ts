import { charge, chargeForcing, unaccounted } from "./counters.js";
/** The two leaf classes and the one number rule. Recognition is module-private:
 * a leaf of another installation is not a leaf here (it enters through
 * `external`). No global JSON method or prototype is changed. */
import rawJSON from "core-js-pure/actual/json/raw-json.js";
import isRawJSON from "core-js-pure/actual/json/is-raw-json.js";
import { ValueError, admission } from "./errors.js";
import { isForcingReason, type ForcingReason } from "./counters.js";

/** The object `JSON.rawJSON(text)` returns: frozen, null prototype, one string
 * property `rawJSON`. `JSON.isRawJSON` authenticates it by an internal slot. */
export interface RawJSON {
  readonly rawJSON: string;
}

export type Numeric = number | Decimal;
export type Text = string | Encoded;

const key = Symbol("openbindings-json-leaf-construction");

// ---------------------------------------------------------------------------
// Number tokens
// ---------------------------------------------------------------------------

const TOKEN = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/;

/** True for exactly the JSON number grammar (RFC 8259 section 6). */
export function isNumberToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN.test(token);
}

interface Parts { negative: boolean; digits: string; scale: number }

/** Decompose a valid token into `digits * 10^scale` with no leading or
 * trailing zeros in `digits`; `digits` is "" for zero. */
function parts(token: string): Parts {
  const m = TOKEN.exec(token)!;
  let digits = m[2]! + (m[3] ?? "");
  let scale = -(m[3]?.length ?? 0);
  let end = digits.length;
  while (end > 0 && digits.charCodeAt(end - 1) === 48) end--;
  scale += digits.length - end;
  let start = 0;
  while (start < end && digits.charCodeAt(start) === 48) start++;
  digits = digits.slice(start, end);
  if (m[4] !== undefined) scale += Number(m[4]);
  return { negative: m[1] === "-", digits, scale };
}

/** The safe-integer value a valid token denotes, or undefined when the token's
 * value is not a safe integer. Spelling never matters: "3", "3.0" and "3e0"
 * all give 3; "-0" gives 0. */
export function safeIntegerOf(token: string): number | undefined {
  const { negative, digits, scale } = parts(token);
  if (digits === "") return 0;
  if (scale < 0 || digits.length + scale > 16) return undefined;
  const value = Number(digits + "0".repeat(scale));
  if (!Number.isSafeInteger(value)) return undefined;
  return negative ? -value : value;
}

// ---------------------------------------------------------------------------
// Decimal
// ---------------------------------------------------------------------------

// Test the actual token/serializer pair once. A pure rawJSON polyfill can
// produce authenticated tokens even when native JSON.stringify cannot write
// them. Merely checking for a method named rawJSON would silently emit objects.
const nativeRawSerialization = (() => {
  try {
    return JSON.stringify(rawJSON("9007199254740993")) === "9007199254740993";
  } catch {
    return false;
  }
})();

let createDecimal!: (raw: RawJSON) => Decimal;
let checkDecimal!: (value: object) => boolean;

function decimalReceiver(value: unknown): Decimal {
  if (!isDecimal(value)) throw admission("Not a Decimal of this installation; a prototype forgery is outside the JSON domain");
  return value;
}

/** An exact JSON number that is not a safe integer, in the digits it arrived
 * with. `raw` is an authenticated rawJSON token object; `toJSON()` returns it
 * only when the host serializer supports it, otherwise ERR_JSON_COERCION;
 * `toString()` returns the digits; `valueOf()` throws ERR_JSON_COERCION. */
export class Decimal {
  #brand: undefined;
  declare readonly raw: RawJSON;
  private constructor(raw: RawJSON, construction: symbol) {
    if (construction !== key) throw admission("Decimal instances come from parse, number and admission only");
    Object.defineProperty(this, "raw", { value: raw, enumerable: true, writable: false, configurable: false });
    Object.freeze(this);
  }
  static {
    createDecimal = raw => new Decimal(raw, key);
    checkDecimal = value => #brand in value;
  }
  static [Symbol.hasInstance](value: unknown): boolean { return isDecimal(value); }
  toJSON(): RawJSON {
    const value = decimalReceiver(this);
    if (!nativeRawSerialization) {
      throw new ValueError("ERR_JSON_COERCION", "Native JSON.stringify cannot preserve Decimal values on this host; use json.stringify(value)", {
        details: { reason: "native-raw-json-unavailable" },
      });
    }
    return value.raw;
  }
  toString(): string { return decimalReceiver(this).raw.rawJSON; }
  valueOf(): never {
    decimalReceiver(this);
    throw new ValueError("ERR_JSON_COERCION", "A Decimal does not coerce to a JavaScript number; use toNumber(value) or toNumber(value, { lossy: true })");
  }
}

export function isDecimal(value: unknown): value is Decimal {
  return typeof value === "object" && value !== null && checkDecimal(value);
}

/** True for a finite primitive number or a Decimal of this installation. */
export function isNumber(value: unknown): value is Numeric {
  return (typeof value === "number" && Number.isFinite(value)) || isDecimal(value);
}

/** The number a token denotes under the one rule. */
export function number(token: string): Numeric {
  if (!isNumberToken(token)) throw new ValueError("ERR_JSON_SYNTAX", "Not a JSON number token");
  const safe = safeIntegerOf(token);
  return safe !== undefined ? safe : createDecimal(rawJSON(token) as RawJSON);
}

/** Admit a JavaScript number: a safe integer stays primitive (-0 becomes 0);
 * every other finite number is the Decimal of its shortest round-trip digits. */
export function admitNumber(value: number, path?: readonly string[]): Numeric {
  if (Number.isSafeInteger(value)) return value === 0 ? 0 : value;
  if (!Number.isFinite(value)) throw admission("A non-finite number is outside the JSON domain", path);
  return createDecimal(rawJSON(String(value)) as RawJSON);
}

/** The exact token of a Numeric. A primitive prints in shortest form. */
export function tokenOf(value: Numeric): string {
  return typeof value === "number" ? (value === 0 ? "0" : String(value)) : value.raw.rawJSON;
}

const view = new DataView(new ArrayBuffer(8));
/** True when binary64 `native` is exactly the value the token denotes. */
function exactlyHeld(native: number, token: string): boolean {
  const { negative, digits, scale } = parts(token);
  if (digits === "") return native === 0;
  if (native === 0 || negative !== native < 0) return false;
  // A finite non-zero binary64 lies in [5e-324, 1.8e308]; a token outside
  // that magnitude cannot equal it, and this keeps every BigInt small.
  const magnitude = digits.length + scale;
  if (magnitude > 310 || magnitude < -325) return false;
  view.setFloat64(0, Math.abs(native));
  const high = view.getUint32(0), low = view.getUint32(4);
  const biased = (high >>> 20) & 0x7ff;
  let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  let exponent: number;
  if (biased === 0) exponent = -1074;
  else { mantissa |= 1n << 52n; exponent = biased - 1075; }
  while ((mantissa & 1n) === 0n) { mantissa >>= 1n; exponent++; }
  let left = BigInt(digits), right = mantissa;
  if (scale > 0) left *= 10n ** BigInt(scale); else if (scale < 0) right *= 10n ** BigInt(-scale);
  if (exponent > 0) right <<= BigInt(exponent); else if (exponent < 0) left <<= BigInt(-exponent);
  return left === right;
}

/** A JavaScript number for a Numeric: exact by default, nearest under lossy.
 * A non-finite primitive and a non-Numeric are ERR_JSON_ADMISSION. */
export function toNumber(value: Numeric, options?: { readonly lossy?: boolean }): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw admission("A non-finite number is outside the JSON domain");
    return value;
  }
  if (!isDecimal(value)) throw admission("Expected a number or a Decimal of this installation");
  const token = value.raw.rawJSON, native = Number(token);
  if (!Number.isFinite(native)) throw new ValueError("ERR_JSON_INEXACT", "The value overflows binary64", { details: { reason: "overflow" } });
  if (options?.lossy) return native;
  if (!exactlyHeld(native, token)) throw new ValueError("ERR_JSON_INEXACT", "binary64 cannot hold the value exactly; pass { lossy: true } to round", { details: { reason: "inexact" } });
  return native;
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
/* eslint-disable @typescript-eslint/unbound-method -- Intrinsic getters are captured once and always invoked with .call(receiver). */
const typedBuffer = Object.getOwnPropertyDescriptor(typed, "buffer")!.get!;
const typedOffset = Object.getOwnPropertyDescriptor(typed, "byteOffset")!.get!;
const typedLength = Object.getOwnPropertyDescriptor(typed, "byteLength")!.get!;
const typedName = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)!.get!;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
// ES2024; absent on the Node 18 floor, where the construction guard below catches a detached buffer.
const detached = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "detached")?.get;
/* eslint-enable @typescript-eslint/unbound-method */

/** A fresh plain view over genuine Uint8Array storage. Intrinsic access avoids
 * subclass getters, iterators and species hooks. Shared, resizable and
 * detached storage are refused. */
export function byteView(bytes: unknown, path?: readonly string[]): Uint8Array {
  if (typedName.call(bytes) !== "Uint8Array") throw admission("Expected a Uint8Array", path);
  const buffer = typedBuffer.call(bytes) as ArrayBuffer;
  try { bufferLength.call(buffer); } catch { throw admission("Shared or invalid byte storage is not admitted", path); }
  if (resizable?.call(buffer)) throw admission("Resizable byte storage is not admitted", path);
  if (detached?.call(buffer)) throw admission("Detached byte storage is not admitted", path);
  try { return new Uint8Array(buffer, typedOffset.call(bytes) as number, typedLength.call(bytes) as number); }
  catch (cause) { throw admission("Detached or invalid byte storage is not admitted", path, cause); }
}

function copyOf(source: Uint8Array): Uint8Array {
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  charge("bytesCopied", copy.byteLength);
  return copy;
}

/** Count Unicode code points without allocating. A lone surrogate counts as
 * one, as the string iterator counts it. Stops early once `limit` is passed. */
export function codePointCount(text: string, limit = Infinity): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    if (++count > limit) return count;
  }
  return count;
}

function base64Encode(bytes: Uint8Array): string {
  const chunks: string[] = [];
  // Chunk boundaries are multiples of three, so padding occurs only at the end.
  for (let offset = 0; offset < bytes.length; offset += 12288) {
    let binary = "";
    const end = Math.min(offset + 12288, bytes.length);
    for (let i = offset; i < end; i++) binary += String.fromCharCode(bytes[i]!);
    chunks.push(btoa(binary));
  }
  return chunks.join("");
}

// ---------------------------------------------------------------------------
// Encoding and Encoded
// ---------------------------------------------------------------------------

/** A string encoding for byte-backed strings. Identity is compatibility: a
 * value is Base64 when `encoding === BASE64`, never when an encoding is named
 * Base64. Both callbacks must be deterministic. */
export interface Encoding {
  readonly length: (bytes: Uint8Array) => number;
  readonly encode: (bytes: Uint8Array) => string;
}

/** The built-in canonical Base64 encoding (RFC 4648 section 4, with padding).
 * A direct `BASE64.encode` call counts as an encode. */
export const BASE64: Encoding = Object.freeze({
  length: (bytes: Uint8Array): number => Math.ceil(byteView(bytes).byteLength / 3) * 4,
  encode: (bytes: Uint8Array): string => {
    const source = byteView(bytes), text = base64Encode(source);
    charge("encodes");
    charge("bytesEncoded", source.byteLength);
    return text;
  },
});

interface Failure { readonly message: string; readonly cause?: unknown }

let createEncoded!: (bytes: Uint8Array, length: number, encoding: Encoding, encode: Encoding["encode"]) => Encoded;
let checkEncoded!: (value: object) => boolean;
let forceEncoded!: (value: Encoded, reason: ForcingReason, path?: readonly string[]) => string;
let copyEncodedInto!: (value: Encoded, destination: Uint8Array) => number;
let equalEncoded!: (a: Encoded, b: Encoded) => boolean;
let encoderOf!: (value: Encoded) => Encoding["encode"];

function encodedReceiver(value: unknown): Encoded {
  if (!isEncoded(value)) throw admission("Not an Encoded of this installation; a prototype forgery is outside the JSON domain");
  return value;
}

/** A JSON string with byte backing. Its characters exist only when something
 * needs them; then they are produced once and kept. A failed custom encode
 * is kept as a failure: the encoder never runs twice. */
export class Encoded {
  #bytes: Uint8Array;
  #encode: Encoding["encode"];
  #text: string | undefined;
  #failure: Failure | undefined;
  declare readonly byteLength: number;
  declare readonly length: number;
  declare readonly encoding: Encoding;
  private constructor(bytes: Uint8Array, length: number, encoding: Encoding, encode: Encoding["encode"], construction: symbol) {
    if (construction !== key) throw admission("Encoded instances come from base64, encoded and external only");
    this.#bytes = bytes;
    this.#encode = encode;
    Object.defineProperty(this, "byteLength", { value: bytes.byteLength, enumerable: true, writable: false, configurable: false });
    Object.defineProperty(this, "length", { value: length, enumerable: true, writable: false, configurable: false });
    Object.defineProperty(this, "encoding", { value: encoding, enumerable: true, writable: false, configurable: false });
    Object.freeze(this);
  }
  static {
    createEncoded = (bytes, length, encoding, encode) => new Encoded(bytes, length, encoding, encode, key);
    checkEncoded = value => #bytes in value;
    encoderOf = value => value.#encode;
    forceEncoded = (value, reason, path) => {
      if (value.#text !== undefined) return value.#text;
      if (value.#failure !== undefined) throw admission(value.#failure.message, path, value.#failure.cause);
      if (!isForcingReason(reason)) throw admission("Unknown string forcing reason", path);
      const bytes = value.#bytes;
      let text: string;
      if (value.#encode === BASE64.encode) text = base64Encode(bytes);
      else {
        const disposable = copyOf(bytes);
        try { text = unaccounted(() => value.#encode(disposable)); }
        catch (cause) {
          value.#failure = { message: "The string encoding's encode callback failed", cause };
          throw admission(value.#failure.message, path, cause);
        }
        if (typeof text !== "string" || text.length > value.length * 2 || codePointCount(text, value.length) !== value.length) {
          value.#failure = { message: "The encode result's code-point length differs from the declared length" };
          throw admission(value.#failure.message, path);
        }
      }
      charge("encodes");
      charge("bytesEncoded", bytes.byteLength);
      chargeForcing(reason, bytes.byteLength);
      value.#text = text;
      return text;
    };
    copyEncodedInto = (value, destination) => {
      const target = byteView(destination);
      if (target.byteLength !== value.#bytes.byteLength) throw admission("Byte destination length mismatch");
      target.set(value.#bytes);
      charge("bytesCopied", target.byteLength);
      return target.byteLength;
    };
    equalEncoded = (a, b) => {
      if (a === b) return true;
      // Compatibility is the encoder function, which survives the external seam.
      if (a.#encode === b.#encode) {
        const x = a.#bytes, y = b.#bytes;
        if (x.byteLength === y.byteLength) {
          let same = true;
          for (let i = 0; i < x.byteLength; i++) if (x[i] !== y[i]) { same = false; break; }
          if (same) return true;
        }
        // Canonical Base64 is injective: different bytes are different strings.
        if (a.#encode === BASE64.encode) return false;
      }
      return forceEncoded(a, "string-operation") === forceEncoded(b, "string-operation");
    };
  }
  static [Symbol.hasInstance](value: unknown): boolean { return isEncoded(value); }
  /** A new copy of the bytes. */
  bytes(): Uint8Array { return copyOf(encodedReceiver(this).#bytes); }
  toString(): string { return forceEncoded(encodedReceiver(this), "string-operation"); }
  toJSON(): string { return forceEncoded(encodedReceiver(this), "export"); }
  [Symbol.toPrimitive](hint: "default" | "string" | "number"): string {
    encodedReceiver(this);
    if (hint === "number") throw new ValueError("ERR_JSON_COERCION", "An Encoded string does not coerce to a number");
    return forceEncoded(this, "string-operation");
  }
}

export { forceEncoded, copyEncodedInto, equalEncoded, encoderOf };

export function isEncoded(value: unknown): value is Encoded {
  return typeof value === "object" && value !== null && checkEncoded(value);
}

/** An Encoded whose encoding is BASE64, holding a copy of the bytes. */
export function base64(bytes: Uint8Array): Encoded {
  const source = byteView(bytes);
  return createEncoded(copyOf(source), Math.ceil(source.byteLength / 3) * 4, BASE64, BASE64.encode);
}

/** An Encoded whose encoding is the given object, holding a copy of the bytes.
 * The length callback runs on the caller's own array before the copy. */
export function encoded(bytes: Uint8Array, encoding: Encoding): Encoded {
  byteView(bytes);
  if (encoding === null || typeof encoding !== "object") throw admission("Expected an Encoding object");
  const { length: measure, encode } = encoding;
  if (typeof measure !== "function" || typeof encode !== "function") throw admission("An Encoding needs length and encode functions");
  let length: unknown;
  try { length = measure(bytes); }
  catch (cause) {
    if (cause instanceof ValueError) throw cause;
    throw admission("The string encoding's length callback failed", undefined, cause);
  }
  const source = byteView(bytes);
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(source.byteLength + length * 4)) {
    throw admission("The string encoding's length must be a non-negative safe integer");
  }
  if (encode === BASE64.encode && length !== Math.ceil(source.byteLength / 3) * 4) {
    throw admission("Base64 storage length contradicts the Base64 formula");
  }
  return createEncoded(copyOf(source), length, encoding, encode);
}

/** Build an Encoded from storage this package already owns (external). */
export function ownedEncoded(bytes: Uint8Array, length: number, encoding: Encoding, encode: Encoding["encode"]): Encoded {
  return createEncoded(bytes, length, encoding, encode);
}

/** A fresh copy of the bytes for an Encoded of this installation; otherwise undefined. */
export function bytes(value: unknown): Uint8Array | undefined {
  return isEncoded(value) ? value.bytes() : undefined;
}

/** True for a genuine rawJSON token object, of any installation. */
export function isRawJSONToken(value: unknown): value is RawJSON {
  return isRawJSON(value);
}

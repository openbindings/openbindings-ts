import { compareNumber, splitNumber, isNumber } from "lossless-json";

/** Operation limits are resource limits, not JSON admission/encoding limits.
 * @deprecated Internal to json-schema; the public surface reports the same limit as ValueError ERR_JSON_BUDGET. */
export class JSONCapabilityError extends RangeError {
  constructor(operation: string) { super(`Exact JSON ${operation} exceeds its supported work limit`); this.name = "JSONCapabilityError"; }
}

const MAX_TOKEN = 4096;
const MAX_EXPONENT = 10000n;
function parts(token: string) {
  if (token.length > MAX_TOKEN) throw new JSONCapabilityError("numeric predicate");
  if (!isNumber(token)) throw new TypeError("Invalid JSON number token");
  const exponent = BigInt(token.match(/[eE]([+-]?\d+)$/)?.[1] ?? 0);
  if (exponent < -MAX_EXPONENT || exponent > MAX_EXPONENT) throw new JSONCapabilityError("numeric predicate");
  return splitNumber(token);
}

/** @deprecated Use `compare` from `@openbindings/json/advanced`. */
export function compareNumberTokens(a: string, b: string): -1 | 0 | 1 {
  const aa = parts(a);
  if (a === b) return 0; // work admission still precedes the shortcut
  const bb = parts(b);
  // lossless-json 4.3.1's exponent comparison otherwise mishandles zero.
  if (aa.digits === "0") return bb.digits === "0" ? 0 : bb.sign === "-" ? 1 : -1;
  if (bb.digits === "0") return aa.sign === "-" ? -1 : 1;
  return compareNumber(a, b);
}

// Package-private acceleration material, not an exported canonical format.
// The existing library owns decimal decomposition, including trailing zeros.
export function numberIndexKey(token: string): string {
  const p = parts(token);
  if (p.digits === "0") return "n0";
  // A temporary native approximation is only an index candidate. Use it
  // solely after exact comparison proves its JSON token denotes this value;
  // the stored/authored value is never converted or replaced.
  const native = Number(token), candidate = String(native);
  if (Number.isFinite(native) && compareNumberTokens(token, candidate) === 0) return "n" + candidate;
  return `q${p.sign}:${p.digits}:${p.exponent}`;
}

/** @deprecated Internal to json-schema; not part of the public surface. */
export function integerNumberToken(token: string): boolean {
  const p = parts(token);
  return p.digits === "0" || p.exponent >= p.digits.length - 1;
}

/** @deprecated Internal to json-schema; not part of the public surface. */
export function multipleNumberTokens(value: string, divisor: string): boolean {
  const a = parts(value), b = parts(divisor);
  if (b.digits === "0") throw new TypeError("Zero divisor is not a JSON Schema multipleOf");
  const scale = a.exponent - a.digits.length - (b.exponent - b.digits.length);
  const numerator = BigInt(a.digits) * (scale > 0 ? 10n ** BigInt(scale) : 1n);
  const denominator = BigInt(b.digits) * (scale < 0 ? 10n ** BigInt(-scale) : 1n);
  return numerator % denominator === 0n;
}

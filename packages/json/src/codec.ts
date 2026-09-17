import { charge } from "./counters.js";
/** Text to value and back, and the whole-value operations, over plain data
 * with rich leaves. One hook-free walk each; no intermediate logical tree.
 * Every walk carries an explicit depth charged against the limits in force,
 * and any residual engine limit is reported as ERR_JSON_BUDGET. */
import jsonParse from "core-js-pure/actual/json/parse.js";
import { ValueError, admission, budget as budgetError, pointer } from "./errors.js";

import { compareNumberTokens, JSONCapabilityError } from "./number.js";
import { authenticate, isAuthenticated } from "./authenticate.js";
import {
  BASE64, Decimal, Encoded, admitNumber, equalEncoded, forceEncoded, isDecimal, isEncoded, isRawJSONToken, number, toNumber, tokenOf, type Numeric,
} from "./leaves.js";

export type Value =
  | null
  | boolean
  | number
  | string
  | Decimal
  | Encoded
  | readonly Value[]
  | { readonly [key: string]: Value };

export type Plain = null | boolean | number | string | Plain[] | { [key: string]: Plain };

export interface Limits {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxBytes?: number;
}

export interface ParseOptions {
  readonly limits?: Limits;
}

export interface PlainOptions {
  readonly numbers?: "throw" | "lossy" | "token";
}

export interface Size {
  readonly nodes: number;
  readonly scalarBytes: number;
  readonly nativeBytes: number;
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

type ResolvedLimits = { -readonly [K in keyof Required<Limits>]: number };
export const defaultLimits: Readonly<ResolvedLimits> = Object.freeze({ maxDepth: 512, maxNodes: 1_000_000, maxBytes: 64 * 1024 * 1024 });

export interface Budget {
  readonly limits: Readonly<ResolvedLimits>;
  nodes: number;
  bytes: number;
  /** Charge one node at `depth`; then charge `size` bytes. */
  visit(depth: number, size?: number): void;
  size(size: number): void;
  /** Refuse a container whose declared child count cannot fit the node budget. */
  reserve(count: number): void;
}

export function budget(options: Limits | undefined): Budget {
  const limits: ResolvedLimits = { ...defaultLimits };
  if (options !== undefined) {
    if (options === null || typeof options !== "object") throw admission("Limits must be an object");
    for (const name of ["maxDepth", "maxNodes", "maxBytes"] as const) {
      const value = options[name];
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value < 1) throw admission(`Limits.${name} must be a positive safe integer`);
      limits[name] = value;
    }
  }
  return {
    limits, nodes: 0, bytes: 0,
    visit(depth, size = 0) {
      if (depth > limits.maxDepth) throw depthError(limits.maxDepth, depth);
      if (++this.nodes > limits.maxNodes) throw budgetError("Value node count exceeds maxNodes", limits.maxNodes, this.nodes);
      if (size) this.size(size);
    },
    size(size) {
      if ((this.bytes += size) > limits.maxBytes) throw budgetError("Value byte size exceeds maxBytes", limits.maxBytes, this.bytes);
    },
    reserve(count) {
      if (count > limits.maxNodes - this.nodes) throw budgetError("Declared length exceeds the remaining node budget", limits.maxNodes, this.nodes + count);
    },
  };
}

function depthError(limit: number, actual: number): ValueError {
  return budgetError("Value depth exceeds maxDepth", limit, actual);
}

/** Convert the engine's own limit (a RangeError such as a stack overflow) into
 * the declared budget failure. Adapter and callback errors never reach here:
 * the walks wrap them as ERR_JSON_ADMISSION with cause first. */
export function guarded<T>(operation: () => T): T {
  try { return operation(); }
  catch (cause) {
    if (cause instanceof RangeError && !(cause instanceof ValueError)) {
      throw new ValueError("ERR_JSON_BUDGET", "The engine's own limit was reached before a Limits value", { details: { reason: "engine-stack" }, cause });
    }
    throw cause;
  }
}

// ---------------------------------------------------------------------------
// Container admission (shared by every walk)
// ---------------------------------------------------------------------------

/** Classify a value at one node of a walk. Everything outside the domain is
 * ERR_JSON_ADMISSION. Getters are never invoked; hooks are never read. */
export type Kind = "null" | "boolean" | "number" | "string" | "decimal" | "encoded" | "array" | "object";

export function kindOf(value: unknown, path: readonly string[]): Kind {
  switch (typeof value) {
    case "boolean": return "boolean";
    case "string": return "string";
    case "number":
      if (!Number.isFinite(value)) throw admission("A non-finite number is outside the JSON domain", path);
      return "number";
    case "object": {
      if (value === null) return "null";
      if (isDecimal(value)) return "decimal";
      if (isEncoded(value)) return "encoded";
      const prototype: unknown = Object.getPrototypeOf(value);
      if (Array.isArray(value)) {
        if (prototype !== Array.prototype && prototype !== null) throw admission("An Array subclass instance is a host object outside the JSON domain", path);
        return "array";
      }
      if (isRawJSONToken(value)) throw admission("A bare rawJSON object is outside the JSON domain; numbers are Decimal", path);
      if (prototype !== Object.prototype && prototype !== null) throw admission("A host object is outside the JSON domain", path);
      return "object";
    }
    case "undefined": throw admission("undefined is outside the JSON domain", path);
    case "function": throw admission("A function is outside the JSON domain", path);
    case "symbol": throw admission("A symbol is outside the JSON domain", path);
    default: throw admission("A bigint is outside the JSON domain", path);
  }
}

/** Validate an array's own keys: dense, no extra members, no symbols. */
export function arrayKeys(value: readonly unknown[], path: readonly string[]): void {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys[value.length] !== "length") {
    throw admission("A JSON array has only its elements and no holes", path);
  }
}

/** The element at an index, read through its descriptor (no getter runs). */
export function element(value: readonly unknown[], index: number, path: readonly string[]): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, index);
  if (descriptor === undefined) throw admission("A JSON array has no holes", path);
  if (!("value" in descriptor)) throw admission("A JSON array element must be a data property; accessors are refused before they run", path);
  if (!descriptor.enumerable) throw admission("A JSON array element must be enumerable; a non-enumerable element is outside the JSON domain", path);
  return descriptor.value;
}

/** Own string keys of a plain object after validating every descriptor. */
export function memberKeys(value: object, path: string[]): string[] {
  const keys = Reflect.ownKeys(value), out: string[] = [];
  for (const key of keys) {
    if (typeof key !== "string") throw admission("A symbol-keyed member is outside the JSON domain", path);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor)) { path.push(key); throw admission("A JSON member must be a data property; accessors are refused before they run", path); }
    if (!descriptor.enumerable) { path.push(key); throw admission("A JSON member must be enumerable; a non-enumerable member is outside the JSON domain", path); }
    out.push(key);
  }
  return out;
}

export function member(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)!.value;
}

function enter(active: Set<object>, value: object, path: readonly string[]): void {
  if (active.has(value)) throw admission("A cyclic value is outside the JSON domain", path);
  active.add(value);
}

function encodedBytes(value: Encoded): { scalar: number; native: number } {
  const native = value.byteLength;
  return { native, scalar: value.encoding === BASE64 ? native : native + value.length * 4 };
}

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

/** Refuse text nested deeper than `maxDepth` before the engine parses it: a
 * linear scan of brackets outside string literals. The engine's reviver walk
 * would overflow its own stack before the per-node budget could run. */
function scanDepth(text: string, maxDepth: number): void {
  // Exceeding maxDepth needs at least 2 * (maxDepth + 1) characters.
  if (text.length < 2 * (maxDepth + 1)) return;
  let nesting = 0, inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92) i++;
      else if (c === 34) inString = false;
      continue;
    }
    if (c === 91 || c === 123) { if (nesting > maxDepth) throw depthError(maxDepth, nesting); nesting++; }
    else if (c === 93 || c === 125) nesting--;
    else if (c === 34) { if (nesting > maxDepth) throw depthError(maxDepth, nesting); inString = true; }
    else if (c === 45 || (c >= 48 && c <= 57) || c === 116 || c === 102 || c === 110) { if (nesting > maxDepth) throw depthError(maxDepth, nesting); }
  }
}

/** JSON.parse with exact numbers and no reviver. */
export function parse<T = any>(text: string, options?: ParseOptions): T {
  if (typeof text !== "string") throw admission("parse expects JSON text as a string");
  const limits = budget(options?.limits);
  scanDepth(text, limits.limits.maxDepth);
  let value: unknown;
  try {
    value = jsonParse(text, function (this: unknown, key, item, context) {
      let size = 0;
      if (typeof item === "number") {
        const source = context.source;
        if (source === undefined) throw new Error("JSON source-text access is unavailable");
        item = number(source);
        size = source.length * 2;
      } else if (typeof item === "string") size = item.length * 2;
      if (!Array.isArray(this)) size += key.length * 2;
      limits.visit(0, size);
      return item;
    });
  } catch (cause) {
    if (cause instanceof ValueError) throw cause;
    if (cause instanceof SyntaxError) throw new ValueError("ERR_JSON_SYNTAX", "Malformed JSON text", { cause });
    return guarded(() => { throw cause; });
  }
  if (typeof value === "object" && value !== null && !isDecimal(value)) charge("treesBuilt");
  return value as T;
}

// ---------------------------------------------------------------------------
// stringify
// ---------------------------------------------------------------------------

function gapOf(space: number | string | undefined): string {
  if (typeof space === "number") return space >= 1 ? " ".repeat(Math.min(10, Math.trunc(space))) : "";
  if (typeof space === "string") return space.slice(0, 10);
  return "";
}

/** JSON text for a Value: Decimal digits, Encoded logical strings (forcing
 * reason "export"), insertion order. Never calls toJSON. Depth is charged
 * against the default maxDepth. */
export function stringify(value: Value, space?: number | string): string {
  charge("serializations");
  return guarded(() => write(value, gapOf(space), "", new Set(), [], 0));
}

function write(value: unknown, gap: string, indent: string, active: Set<object>, path: string[], depth: number): string {
  charge("nodesRead");
  if (depth > defaultLimits.maxDepth) throw depthError(defaultLimits.maxDepth, depth);
  switch (kindOf(value, path)) {
    case "null": return "null";
    case "boolean": return value ? "true" : "false";
    case "number": return tokenOf(value as number);
    case "string": return JSON.stringify(value);
    case "decimal": return (value as Decimal).raw.rawJSON;
    case "encoded": return JSON.stringify(forceEncoded(value as Encoded, "export", path));
    case "array": {
      const items = value as readonly unknown[];
      arrayKeys(items, path);
      if (items.length === 0) return "[]";
      enter(active, items, path);
      const inner = indent + gap;
      let out = gap ? "[\n" + inner : "[";
      for (let i = 0; i < items.length; i++) {
        path.push(String(i));
        const text = write(element(items, i, path), gap, inner, active, path, depth + 1);
        path.pop();
        out += (i === 0 ? "" : gap ? ",\n" + inner : ",") + text;
      }
      active.delete(items);
      return out + (gap ? "\n" + indent + "]" : "]");
    }
    default: {
      const object = value as object;
      const keys = memberKeys(object, path);
      if (keys.length === 0) return "{}";
      enter(active, object, path);
      const inner = indent + gap, colon = gap ? ": " : ":";
      let out = gap ? "{\n" + inner : "{";
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        path.push(key);
        const text = write(member(object, key), gap, inner, active, path, depth + 1);
        path.pop();
        out += (i === 0 ? "" : gap ? ",\n" + inner : ",") + JSON.stringify(key) + colon + text;
      }
      active.delete(object);
      return out + (gap ? "\n" + indent + "}" : "}");
    }
  }
}

// ---------------------------------------------------------------------------
// equal and compare
// ---------------------------------------------------------------------------

/** Compare two exact tokens. Identical text is exact without any predicate
 * work; otherwise the numeric predicate's limits (4,096 characters, exponent
 * magnitude 10,000) apply and are reported as ERR_JSON_BUDGET. */
export function compareTokens(a: string, b: string): -1 | 0 | 1 {
  if (a === b) return 0;
  try { return compareNumberTokens(a, b); }
  catch (cause) {
    if (cause instanceof JSONCapabilityError) {
      throw new ValueError("ERR_JSON_BUDGET", "Numeric comparison exceeds its work limit (4,096 token characters or an exponent beyond 10,000)", { details: { reason: "numeric-predicate" }, cause });
    }
    throw cause;
  }
}

/** True when two values are the same logical JSON. Identical operands are
 * equal without any token work. */
export function equal(a: Value, b: Value): boolean {
  return guarded(() => same(a, b, new Set(), new Set(), [], 0));
}

function same(a: unknown, b: unknown, activeA: Set<object>, activeB: Set<object>, path: string[], depth: number): boolean {
  charge("nodesRead", 2);
  if (depth > defaultLimits.maxDepth) throw depthError(defaultLimits.maxDepth, depth);
  const ka = kindOf(a, path), kb = kindOf(b, path);
  if (a === b) return true;
  const na = ka === "number" || ka === "decimal", nb = kb === "number" || kb === "decimal";
  if (na || nb) {
    if (!(na && nb)) return false;
    if (ka === "number" && kb === "number") return false;
    return compareTokens(tokenOf(a as Numeric), tokenOf(b as Numeric)) === 0;
  }
  const sa = ka === "string" || ka === "encoded", sb = kb === "string" || kb === "encoded";
  if (sa || sb) {
    if (!(sa && sb)) return false;
    if (ka === "encoded" && kb === "encoded") return equalEncoded(a as Encoded, b as Encoded);
    const x = ka === "encoded" ? forceEncoded(a as Encoded, "string-operation", path) : a;
    const y = kb === "encoded" ? forceEncoded(b as Encoded, "string-operation", path) : b;
    return x === y;
  }
  if (ka !== kb) return false;
  if (ka === "null" || ka === "boolean") return false;
  if (ka === "array") {
    const x = a as readonly unknown[], y = b as readonly unknown[];
    arrayKeys(x, path); arrayKeys(y, path);
    if (x.length !== y.length) return false;
    enter(activeA, x, path); enter(activeB, y, path);
    try {
      for (let i = 0; i < x.length; i++) {
        path.push(String(i));
        const result = same(element(x, i, path), element(y, i, path), activeA, activeB, path, depth + 1);
        path.pop();
        if (!result) return false;
      }
      return true;
    } finally { activeA.delete(x); activeB.delete(y); }
  }
  const x = a as object, y = b as object;
  const keys = memberKeys(x, path), other = memberKeys(y, path);
  if (keys.length !== other.length) return false;
  enter(activeA, x, path); enter(activeB, y, path);
  try {
    for (const key of keys) {
      if (!Object.hasOwn(y, key)) return false;
      path.push(key);
      const result = same(member(x, key), member(y, key), activeA, activeB, path, depth + 1);
      path.pop();
      if (!result) return false;
    }
    return true;
  } finally { activeA.delete(x); activeB.delete(y); }
}

// ---------------------------------------------------------------------------
// plain
// ---------------------------------------------------------------------------

/** A new graph of primitives and mutable plain containers. Primitive numbers
 * go through the one number rule first, so the result does not depend on
 * whether a value was parsed or written as a literal. */
export function plain(value: Value, options?: PlainOptions): Plain {
  const numbers = options?.numbers ?? "throw";
  if (numbers !== "throw" && numbers !== "lossy" && numbers !== "token") throw admission("plain: numbers must be \"throw\", \"lossy\" or \"token\"");
  const result = guarded(() => project(value, numbers, new Set(), [], 0));
  if (typeof result === "object" && result !== null) charge("treesBuilt");
  return result;
}

function projectNumber(numeric: Numeric, numbers: "throw" | "lossy" | "token", path: string[]): Plain {
  if (typeof numeric === "number") return numeric;
  if (numbers === "token") return numeric.raw.rawJSON;
  try { return toNumber(numeric, { lossy: numbers === "lossy" }); }
  catch (cause) {
    if (cause instanceof ValueError && cause.code === "ERR_JSON_INEXACT") {
      throw new ValueError("ERR_JSON_INEXACT", cause.message, { details: { ...cause.details, path: pointer(path) }, cause });
    }
    throw cause;
  }
}

function project(value: unknown, numbers: "throw" | "lossy" | "token", active: Set<object>, path: string[], depth: number): Plain {
  charge("nodesRead");
  if (depth > defaultLimits.maxDepth) throw depthError(defaultLimits.maxDepth, depth);
  switch (kindOf(value, path)) {
    case "null": return null;
    case "boolean": return value as boolean;
    case "number": return projectNumber(admitNumber(value as number, path), numbers, path);
    case "string": return value as string;
    case "decimal": return projectNumber(value as Decimal, numbers, path);
    case "encoded": return forceEncoded(value as Encoded, "export", path);
    case "array": {
      const items = value as readonly unknown[];
      arrayKeys(items, path);
      enter(active, items, path);
      const out: Plain[] = new Array<Plain>(items.length);
      for (let i = 0; i < items.length; i++) {
        path.push(String(i));
        out[i] = project(element(items, i, path), numbers, active, path, depth + 1);
        path.pop();
      }
      active.delete(items);
      return out;
    }
    default: {
      const object = value as object;
      const keys = memberKeys(object, path);
      enter(active, object, path);
      // Assign into a null-prototype dictionary so no inherited setter runs;
      // restore the ordinary prototype once every own member exists.
      const out = Object.create(null) as Record<string, Plain>;
      for (const key of keys) {
        path.push(key);
        out[key] = project(member(object, key), numbers, active, path, depth + 1);
        path.pop();
      }
      active.delete(object);
      return Object.setPrototypeOf(out, Object.prototype) as { [key: string]: Plain };
    }
  }
}

// ---------------------------------------------------------------------------
// measure and admit (sizeOf, and the engine-side snapshot)
// ---------------------------------------------------------------------------

/** Measure a Value, charging `limits` when one is given. One walk; no encoding, no copying. */
export function measure(value: unknown, limits: Budget | undefined, depth: number, path: string[], active: Set<object>): Size {
  charge("nodesRead");
  limits?.visit(depth);
  let nodes = 1, scalarBytes = 0, nativeBytes = 0;
  switch (kindOf(value, path)) {
    case "null": case "boolean": break;
    case "string": scalarBytes = (value as string).length * 2; break;
    case "number": scalarBytes = tokenOf(value as number).length * 2; break;
    case "decimal": scalarBytes = (value as Decimal).raw.rawJSON.length * 2; break;
    case "encoded": { const size = encodedBytes(value as Encoded); scalarBytes = size.scalar; nativeBytes = size.native; break; }
    case "array": {
      const items = value as readonly unknown[];
      arrayKeys(items, path);
      enter(active, items, path);
      for (let i = 0; i < items.length; i++) {
        path.push(String(i));
        const child = measure(element(items, i, path), limits, depth + 1, path, active);
        path.pop();
        nodes += child.nodes; scalarBytes += child.scalarBytes; nativeBytes += child.nativeBytes;
      }
      active.delete(items);
      break;
    }
    default: {
      const object = value as object;
      const keys = memberKeys(object, path);
      enter(active, object, path);
      for (const key of keys) {
        scalarBytes += key.length * 2;
        limits?.size(key.length * 2);
        path.push(key);
        const child = measure(member(object, key), limits, depth + 1, path, active);
        path.pop();
        nodes += child.nodes; scalarBytes += child.scalarBytes; nativeBytes += child.nativeBytes;
      }
      active.delete(object);
    }
  }
  if (nodes === 1) limits?.size(scalarBytes);
  return { nodes, scalarBytes, nativeBytes };
}

/** Admit a value for an engine: an authenticated graph is returned as is;
 * anything else is walked once into a deeply frozen, authenticated snapshot
 * that shares leaves. Primitive numbers follow the one rule. Not counted in
 * `treesBuilt` (engine-internal). */
export function admit(value: unknown, limits?: Limits): Value {
  const b = budget(limits);
  return guarded(() => snapshot(value, b, 0, new Set(), []));
}

function snapshot(value: unknown, limits: Budget, depth: number, active: Set<object>, path: string[]): Value {
  if (isAuthenticated(value)) {
    // Reuse without copying; the caller's budget still applies to the graph.
    measure(value, limits, depth, path, active);
    return value as Value;
  }
  charge("nodesRead");
  switch (kindOf(value, path)) {
    case "null": case "boolean": limits.visit(depth); return value as null | boolean;
    case "string": limits.visit(depth, (value as string).length * 2); return value as string;
    case "number": { const admitted = admitNumber(value as number, path); limits.visit(depth, tokenOf(admitted).length * 2); return admitted; }
    case "decimal": limits.visit(depth, (value as Decimal).raw.rawJSON.length * 2); return value as Decimal;
    case "encoded": limits.visit(depth, encodedBytes(value as Encoded).scalar); return value as Encoded;
    case "array": {
      const items = value as readonly unknown[];
      limits.visit(depth);
      arrayKeys(items, path);
      enter(active, items, path);
      const out: Value[] = new Array<Value>(items.length);
      for (let i = 0; i < items.length; i++) {
        path.push(String(i));
        out[i] = snapshot(element(items, i, path), limits, depth + 1, active, path);
        path.pop();
      }
      active.delete(items);
      authenticate(Object.freeze(out));
      return out;
    }
    default: {
      const object = value as object;
      limits.visit(depth);
      const keys = memberKeys(object, path);
      enter(active, object, path);
      const out = Object.create(null) as Record<string, Value>;
      for (const key of keys) {
        limits.size(key.length * 2);
        path.push(key);
        out[key] = snapshot(member(object, key), limits, depth + 1, active, path);
        path.pop();
      }
      active.delete(object);
      Object.setPrototypeOf(out, Object.prototype);
      authenticate(Object.freeze(out));
      return out;
    }
  }
}

export { admitNumber };

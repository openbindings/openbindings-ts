// Executes test/value-api-shape.cases.json through the package's public entry
// points, reached only by their public specifiers so that a per-package run
// (aliased to src) and a workspace-root run (resolved to dist) exercise one
// installation each. The table is language-neutral; this file is its
// TypeScript runner. Stage B reuses the same table in Go.
import { describe, expect, it } from "vitest";
import * as json from "@openbindings/json";
import { access, compare, counters, external, sizeOf, type DeferredStringStorage, type ValueAccess } from "@openbindings/json/advanced";
import { admit, authenticate, authenticateGraph, isAuthenticated } from "@openbindings/json/internal";
import rawJSON from "core-js-pure/actual/json/raw-json.js";
import table from "./value-api-shape.cases.json";

// lib ES2022 does not declare the rawJSON proposal; read it without widening the lib.
const nativeJSON = JSON as unknown as { rawJSON?: (text: string) => unknown; isRawJSON?: (value: unknown) => boolean };

interface Case {
  readonly id: string;
  readonly description: string;
  readonly op: string;
  readonly input: Record<string, unknown>;
  readonly expect: Record<string, unknown>;
  readonly languages?: readonly string[];
  readonly runtime?: string;
}

type Recipe = unknown;
interface Context { getterRan: boolean; hookRan: boolean; encoderCalls: number }

const literal = (text: unknown): unknown => text === "$loneSurrogate" ? "\ud800x" : text;
const hexText = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
let hexCalls = 0;
const hex: json.Encoding = { length: b => b.length * 2, encode: b => { hexCalls++; return hexText(b); } };

class ForeignDecimal {
  declare readonly raw: json.RawJSON;
  constructor(token: string) {
    Object.defineProperty(this, "raw", { value: rawJSON(token), enumerable: true });
    Object.freeze(this);
  }
  toJSON(): json.RawJSON { return this.raw; }
  toString(): string { return this.raw.rawJSON; }
  valueOf(): never { throw new Error("foreign coercion"); }
}
class FakeWithRaw { raw: unknown; evil = true; constructor(token: string) { this.raw = rawJSON(token); } }
class MyArray extends Array {}

function nest(depth: number): unknown { let value: unknown = 0; for (let i = 0; i < depth; i++) value = [value]; return value; }

function build(recipe: Recipe, ctx: Context): unknown {
  if (recipe === null || typeof recipe !== "object") return recipe;
  if (Array.isArray(recipe)) return recipe.map(item => build(item, ctx));
  const keys = Object.keys(recipe);
  const r = recipe as Record<string, unknown>;
  if (keys.length === 1 && keys[0]!.startsWith("$")) {
    const arg = r[keys[0]!];
    switch (keys[0]) {
      case "$decimal": { const value = json.number(arg as string); if (!json.isDecimal(value)) throw new Error(`${arg} is not a Decimal`); return value; }
      case "$number": return json.number(arg as string);
      case "$native": return arg as number;
      case "$base64": return json.base64(Uint8Array.from(arg as number[]));
      case "$base64Zeros": return json.base64(new Uint8Array(arg as number));
      case "$hex": return json.encoded(Uint8Array.from(arg as number[]), hex);
      case "$custom": {
        const c = arg as { bytes: number[]; length: number; encode: string };
        return json.encoded(Uint8Array.from(c.bytes), { length: () => c.length, encode: () => {
          ctx.encoderCalls++;
          if (c.encode === "$throw") throw new Error("encoder failed");
          if (c.encode === "$nonString") return 42 as unknown as string;
          return literal(c.encode) as string;
        } });
      }
      case "$parse": return json.parse(arg as string);
      case "$nest": return nest(arg as number);
      case "$bigDecimal": return json.number("1" + "0".repeat((arg as number) - 1));
      case "$nestedText": { const [open, n, close] = arg as [string, number, string]; return open.repeat(n) + "1" + close.repeat(n); }
      case "$undefined": return undefined;
      case "$function": return () => 1;
      case "$symbol": return Symbol("s");
      case "$bigint": return BigInt(arg as string);
      case "$nan": return NaN;
      case "$infinity": return Infinity;
      case "$negzero": return -0;
      case "$accessor": return Object.defineProperty({}, "x", { enumerable: true, get() { ctx.getterRan = true; return 1; } });
      case "$cycle": { const cycle: unknown[] = []; cycle.push(cycle); return cycle; }
      case "$objectCycle": { const cycle: Record<string, unknown> = { a: 1 }; cycle.self = cycle; return cycle; }
      case "$host": return new Date(0);
      case "$rawjson": return rawJSON(arg as string);
      case "$rawjsonShaped": return { rawJSON: arg };
      case "$rawOnly": return { raw: rawJSON(arg as string) };
      case "$rawNonEnumerable": return Object.defineProperty({}, "raw", { value: rawJSON(arg as string), enumerable: false });
      case "$rawExtra": return { raw: rawJSON(arg as string), extra: 1 };
      case "$fakeWithRaw": return new FakeWithRaw(arg as string);
      case "$foreignDecimal": return new ForeignDecimal(arg as string);
      case "$arraySubclass": return MyArray.from(arg as number[]);
      case "$nonEnumerable": return Object.defineProperty({ a: 1 }, "b", { value: 2, enumerable: false });
      case "$nonEnumerableElement": { const array = [1, 2]; Object.defineProperty(array, "0", { enumerable: false }); return array; }
      // eslint-disable-next-line no-sparse-arrays -- a deliberate hole
      case "$hole": return [, 1];
      case "$extra": return Object.assign([1], { metadata: true });
      case "$nullproto": return Object.assign(Object.create(null) as Record<string, unknown>, build(arg, ctx) as Record<string, unknown>);
      case "$toJSON": return { toJSON() { ctx.hookRan = true; return 1; } };
      default: throw new Error(`unknown recipe ${keys[0]}`);
    }
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = build(r[key], ctx);
  return out;
}

function matches(actual: unknown, witness: unknown, where: string): void {
  if (witness === null || typeof witness !== "object") {
    if (typeof witness === "number") {
      expect(typeof actual, where).toBe("number");
      expect(Object.is(actual, witness), `${where}: ${String(actual)} is not ${witness}`).toBe(true);
    } else expect(actual, where).toBe(witness);
    return;
  }
  if (Array.isArray(witness)) {
    expect(Array.isArray(actual), where).toBe(true);
    expect((actual as unknown[]).length, where).toBe(witness.length);
    witness.forEach((item, i) => matches((actual as unknown[])[i], item, `${where}/${i}`));
    return;
  }
  const w = witness as Record<string, unknown>, keys = Object.keys(w);
  if (keys.length === 1 && keys[0]!.startsWith("$")) {
    const arg = w[keys[0]!];
    switch (keys[0]) {
      case "$decimal": expect(json.isDecimal(actual), where).toBe(true); expect(String(actual), where).toBe(arg); return;
      case "$base64": expect(json.isEncoded(actual), where).toBe(true); expect((actual as json.Encoded).encoding === json.BASE64, where).toBe(true); expect([...(actual as json.Encoded).bytes()], where).toEqual(arg); return;
      case "$hex": expect(json.isEncoded(actual), where).toBe(true); expect((actual as json.Encoded).encoding === json.BASE64, where).toBe(false); expect([...(actual as json.Encoded).bytes()], where).toEqual(arg); expect(String(actual), where).toBe(hexText(Uint8Array.from(arg as number[]))); return;
      default: throw new Error(`unknown witness ${keys[0]}`);
    }
  }
  expect(typeof actual === "object" && actual !== null && !Array.isArray(actual) && !json.isDecimal(actual) && !json.isEncoded(actual), where).toBe(true);
  expect(Object.keys(actual as object).sort(), where).toEqual(keys.slice().sort());
  for (const key of keys) matches((actual as Record<string, unknown>)[key], w[key], `${where}/${key}`);
}

function deepFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null || json.isDecimal(value) || json.isEncoded(value)) return true;
  if (!Object.isFrozen(value)) return false;
  return Array.isArray(value) ? value.every(deepFrozen) : Object.values(value).every(deepFrozen);
}

function allAuthenticated(value: unknown): boolean {
  if (typeof value !== "object" || value === null || json.isDecimal(value) || json.isEncoded(value)) return true;
  if (!isAuthenticated(value)) return false;
  return Array.isArray(value) ? value.every(allAuthenticated) : Object.values(value).every(allAuthenticated);
}

function noRichLeaves(value: unknown): boolean {
  if (json.isDecimal(value) || json.isEncoded(value)) return false;
  if (typeof value !== "object" || value === null) return true;
  return Array.isArray(value) ? value.every(noRichLeaves) : Object.values(value).every(noRichLeaves);
}

interface Adapter { root: unknown; access: ValueAccess<unknown>; state?: Record<string, unknown> }
const adapters: Record<string, () => Adapter> = {
  kindThrows: () => ({ root: 1, access: { ...access, kind: () => { throw new Error("adapter failed"); } } as ValueAccess<unknown> }),
  missingToken: () => ({ root: 1, access: { ...access, kind: () => "number", numberToken: () => undefined } as ValueAccess<unknown> }),
  cyclic: () => { const root = {}; return { root, access: { ...access, kind: () => "array", length: () => 1, get: () => root } as ValueAccess<unknown> }; },
  badVersion: () => ({ root: 1, access: { ...access, version: 2 } as unknown as ValueAccess<unknown> }),
  hugeLength: () => ({ root: [], access: { ...access, kind: () => "array", length: () => 2 ** 32, get: () => undefined } as ValueAccess<unknown> }),
  dupKeys: () => ({ root: { a: 1 }, access: { ...access, keys: () => ["a", "a"] } as ValueAccess<unknown> }),
  hugeKeys: () => ({ root: {}, access: { ...access, keys: () => new Array<string>(2 ** 20) } as ValueAccess<unknown> }),
  wrappedShippedHex: () => {
    // A foreign adapter that exposes this installation's custom storage: the import is a distinct leaf sharing the encoder.
    const value = json.encoded(Uint8Array.of(251, 255), hex), storage = access.deferredString!(value)!;
    return { root: { foreign: value }, access: { ...access, kind: () => "string", length: () => 4, deferredString: () => storage } as ValueAccess<unknown>, state: { original: value } };
  },
  badDeferredLength: () => {
    const value = json.base64(Uint8Array.of(1, 2, 3)), storage = access.deferredString!(value)!;
    return { root: { s: value }, access: { ...access, deferredString: (v: unknown) => json.isEncoded(v) ? { ...storage, length: 3 } : undefined, get: (v: unknown, k: string | number) => k === "s" ? { foreign: value } : undefined, kind: (v: unknown) => (v as { foreign?: unknown }).foreign ? "string" : "object", keys: () => ["s"], length: (v: unknown) => (v as { foreign?: unknown }).foreign ? 3 : undefined } as ValueAccess<unknown> };
  },
  shortCopy: () => {
    const value = json.base64(Uint8Array.of(1, 2, 3)), storage = access.deferredString!(value)!, state = { copyCalls: 0 };
    const node = { foreign: value };
    const patched: DeferredStringStorage = { ...storage, copyBytesInto: (d: Uint8Array) => { state.copyCalls++; storage.copyBytesInto(d); return 2; } };
    return { root: node, access: { ...access, kind: () => "string", length: () => 4, deferredString: () => patched } as ValueAccess<unknown>, state };
  },
  wrappedShippedStorage: () => {
    // A foreign adapter that copies through this installation's own storage: charged once.
    const value = json.base64(Uint8Array.of(1, 2, 3)), storage = access.deferredString!(value)!;
    return { root: { foreign: value }, access: { ...access, kind: () => "string", length: () => 4, deferredString: () => storage } as ValueAccess<unknown> };
  },
  foreignBase64: () => {
    const bytes = Uint8Array.of(1, 2, 3), root = { bytes };
    const foreign: ValueAccess<unknown> = {
      version: 1, kind: () => "string", get: () => undefined, keys: () => [], length: () => 4, numberToken: () => undefined, scalar: () => undefined,
      deferredString: () => ({ byteLength: 3, length: 4, encode: json.BASE64.encode, copyBytesInto: (d: Uint8Array) => { d.set(bytes); return 3; } }),
    };
    return { root, access: foreign };
  },
  bigForeignBase64: () => {
    const bytes = new Uint8Array(1000), root = { bytes };
    const foreign: ValueAccess<unknown> = {
      version: 1, kind: () => "string", get: () => undefined, keys: () => [], length: () => 1336, numberToken: () => undefined, scalar: () => undefined,
      deferredString: () => ({ byteLength: 1000, length: 1336, encode: json.BASE64.encode, copyBytesInto: (d: Uint8Array) => { d.set(bytes); return 1000; } }),
    };
    return { root, access: foreign };
  },
  base64LyingLength: () => {
    const foreign: ValueAccess<unknown> = {
      version: 1, kind: () => "string", get: () => undefined, keys: () => [], length: () => 7, numberToken: () => undefined, scalar: () => undefined,
      deferredString: () => ({ byteLength: 2, length: 7, encode: json.BASE64.encode, copyBytesInto: (d: Uint8Array) => { d.set([251, 255]); return 2; } }),
    };
    return { root: {}, access: foreign };
  },
  foreignHex: () => {
    const state = { encoderCalls: 0 }, bytes = Uint8Array.of(251, 255);
    const encode = (b: Uint8Array): string => { state.encoderCalls++; return hexText(b); };
    const foreign: ValueAccess<unknown> = {
      version: 1, kind: () => "string", get: () => undefined, keys: () => [], length: () => 4, numberToken: () => undefined, scalar: () => undefined,
      deferredString: () => ({ byteLength: 2, length: 4, encode, copyBytesInto: (d: Uint8Array) => { d.set(bytes); return 2; } }),
    };
    return { root: {}, access: foreign, state };
  },
  legacyBase64: () => {
    const bytes = Uint8Array.of(1, 2, 3);
    const legacy = {
      version: 1 as const, kind: () => "string" as const, get: () => undefined, keys: () => [], length: () => 4, numberToken: () => undefined, scalar: () => undefined,
      byteLength: () => 3, bytes: () => bytes,
    };
    return { root: {}, access: legacy as ValueAccess<unknown> };
  },
  legacyDetached: () => {
    const bytes = Uint8Array.of(1, 2, 3); (bytes.buffer as ArrayBuffer & { transfer(): ArrayBuffer }).transfer();
    const legacy = {
      version: 1 as const, kind: () => "string" as const, get: () => undefined, keys: () => [], length: () => 4, numberToken: () => undefined, scalar: () => undefined,
      byteLength: () => 3, bytes: () => bytes,
    };
    return { root: {}, access: legacy as ValueAccess<unknown> };
  },
};

const reasons = ["export", "string-operation", "schema-constraint", "diagnostic", "compatibility-executor", "persistence", "transport"] as const;
function deltas(before: json.Costs): Record<string, number> {
  const after = counters(), out: Record<string, number> = {};
  for (const name of ["encodes", "bytesEncoded", "bytesCopied", "serializations", "treesBuilt", "nodesRead"] as const) out[name] = after[name] - before[name];
  for (const reason of reasons) out[`forcing.${reason}`] = after.forcing[reason] - before.forcing[reason];
  return out;
}

const codeOf = (fn: () => unknown): string | null => { try { fn(); return null; } catch (error) { return error instanceof json.ValueError ? error.code : (error as Error).name; } };
const detachedBytes = (list: number[]): Uint8Array => { const u8 = Uint8Array.from(list); (u8.buffer as ArrayBuffer & { transfer(): ArrayBuffer }).transfer(); return u8; };

function walk(via: string, value: unknown, second: unknown): unknown {
  switch (via) {
    case "plain": return json.plain(value as json.Value);
    case "equal": return json.equal(value as json.Value, second as json.Value);
    case "sizeOf": return sizeOf(value as json.Value);
    case "admit": return admit(value);
    case "stringify": return json.stringify(value as json.Value);
    case "external": return external(value, access as ValueAccess<unknown>);
    default: throw new Error(`unknown walk ${via}`);
  }
}

/** Runs the case: builds inputs, snapshots counters, performs the operation,
 * and returns observations (the runner asserts declared expectations). */
function run(c: Case, ctx: Context, obs: Record<string, unknown>): Record<string, unknown> {
  const input = c.input;
  const limits = input.limits as json.Limits | undefined;
  const timed = <T>(fn: () => T): T => { const before = counters(); try { return fn(); } finally { Object.assign(obs, deltas(before)); } };
  switch (c.op) {
    case "parse": { const text = build(input.text, ctx) as string; obs.value = timed(() => json.parse(text, limits ? { limits } : undefined)); break; }
    case "number": obs.value = json.number(input.token as string); break;
    case "toNumber": { const v = build(input.value, ctx) as json.Numeric; obs.value = json.toNumber(v, input.lossy ? { lossy: true } : undefined); break; }
    case "stringify": { const v = build(input.value, ctx) as json.Value; obs.text = timed(() => json.stringify(v, input.space as number | string | undefined)); obs.textLength = (obs.text as string).length; break; }
    case "stringifyTwice": { const v = build(input.value, ctx) as json.Value; obs.text = timed(() => { const first = json.stringify(v); expect(json.stringify(v)).toBe(first); return first; }); break; }
    case "plain": { const v = build(input.value, ctx) as json.Value; obs.value = timed(() => json.plain(v, input.numbers ? { numbers: input.numbers as "throw" } : undefined)); expect(noRichLeaves(obs.value)).toBe(true); break; }
    case "plainMutable": { const v = build(input.value, ctx) as { a: number[] }; const out = json.plain(v) as { a: number[] }; out.a.push(2); obs.value = out !== v && v.a.length === 1 && !Object.isFrozen(out) && !Object.isFrozen(out.a); break; }
    case "equal": { const a = build(input.a, ctx) as json.Value, b = build(input.b, ctx) as json.Value; obs.value = timed(() => json.equal(a, b)); break; }
    case "equalSame": { const v = build(input.value, ctx) as json.Value; obs.value = timed(() => json.equal(v, v)); break; }
    case "equalSameDigits": { const v = build(input.value, ctx) as json.Decimal; obs.value = json.equal(v, json.number(String(v))); break; }
    case "compare": obs.value = compare(build(input.a, ctx) as json.Numeric, build(input.b, ctx) as json.Numeric); break;
    case "compareSame": { const v = build(input.value, ctx) as json.Numeric; obs.value = compare(v, v); break; }
    case "coerce": {
      const v = build(input.value, ctx) as any, operand = input.operand;
      switch (input.operation) {
        case "multiply": obs.value = v * 2; break;
        case "add": obs.value = v + 1; break;
        case "looseEqual": obs.value = v == 0.3; break;
        case "unaryPlus": obs.value = +v; break;
        case "Number": obs.value = Number(v); break;
        case "valueOf": obs.value = v.valueOf(); break;
        case "String": obs.value = String(v); break;
        case "template": obs.value = `${v}`; break;
        case "concat": obs.value = v + "x"; break;
        case "looseEqualString": obs.value = v == operand; break;
        case "JSONStringify": obs.value = JSON.stringify(v); break;
        case "isFrozen": obs.value = Object.isFrozen(v); break;
        case "raw": expect(typeof nativeJSON.isRawJSON !== "function" || nativeJSON.isRawJSON(v.raw)).toBe(true); obs.value = v.raw.rawJSON; break;
        case "toJSON": expect(v.toJSON()).toBe(v.raw); obs.value = v.toJSON().rawJSON; break;
        default: throw new Error(`unknown coercion ${String(input.operation)}`);
      }
      break;
    }
    case "isDecimal": case "isEncoded": case "isNumber": {
      const v = build(input.value, ctx), predicate = json[c.op];
      obs.value = Array.isArray(c.expect.value) ? (v as unknown[]).map(item => predicate(item)) : predicate(v);
      break;
    }
    case "encodedMeta": { const v = build(input.value, ctx) as json.Encoded; timed(() => { obs.byteLength = v.byteLength; obs.length = v.length; obs.isBase64 = v.encoding === json.BASE64; }); break; }
    case "force": { const v = build(input.value, ctx) as json.Encoded; hexCalls = 0; obs.text = timed(() => { let text = ""; for (let i = 0; i < (input.times as number); i++) text = String(v); return text; }); obs.encoderCalls = hexCalls; break; }
    case "bytesCopy": { const v = build(input.value, ctx) as json.Encoded; obs.bytes = timed(() => { const first = v.bytes(); first.fill(99); return [...v.bytes()]; }); break; }
    case "sourceMutation": {
      const source = Uint8Array.from(input.bytes as number[]), v = json.base64(source), m = input.mutate as { index: number; value: number };
      obs.bytes = timed(() => { source[m.index] = m.value; return [...v.bytes()]; });
      obs.text = String(v);
      break;
    }
    case "encodedLengthCallback": {
      const source = Uint8Array.from(input.bytes as number[]); let saw = false;
      const encoding: json.Encoding = { length: b => { saw = b === source; return b.length * 2; }, encode: hexText };
      timed(() => json.encoded(source, encoding)); obs.sawCallerArray = saw;
      break;
    }
    case "encodeCallbackCopy": {
      const source = Uint8Array.from(input.bytes as number[]);
      const v = json.encoded(source, { length: b => b.length * 2, encode: b => { const text = hexText(b); b.fill(0); return text; } });
      obs.text = timed(() => String(v)); obs.bytes = [...v.bytes()];
      break;
    }
    case "bytesOf": { const bytes = json.bytes(build(input.value, ctx)); obs.value = bytes === undefined ? null : [...bytes]; break; }
    case "construct": {
      let bytes: unknown;
      if (typeof input.bytes === "string") bytes = input.bytes;
      else if (input.bytesKind === "array") bytes = input.bytes;
      else if (input.bytesKind === "resizable") bytes = new Uint8Array(new (ArrayBuffer as unknown as new (length: number, options: { maxByteLength: number }) => ArrayBuffer)(8, { maxByteLength: 16 }));
      else if (input.bytesKind === "shared") bytes = new Uint8Array(new SharedArrayBuffer(8));
      else bytes = Uint8Array.from(input.bytes as number[]);
      if (input.factory === "base64") obs.value = json.base64(bytes as Uint8Array);
      else {
        const e = input.encoding, encoding: json.Encoding = e === "hex" ? hex : { length: () => (e as { length: number | string }).length === "Infinity" ? Infinity : (e as { length: number }).length, encode: () => (e as { encode: string }).encode };
        obs.value = json.encoded(bytes as Uint8Array, encoding);
      }
      break;
    }
    case "base64Oracle": obs.value = (input.sizes as number[]).every(size => { const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 131 + 17) % 256); return String(json.base64(bytes)) === Buffer.from(bytes).toString("base64"); }); break;
    case "base64Encode": obs.text = timed(() => json.BASE64.encode(Uint8Array.from(input.bytes as number[]))); break;
    case "encodingMutation": { const encoding = { length: (b: Uint8Array) => b.length * 2, encode: hexText }; const v = json.encoded(Uint8Array.from(input.bytes as number[]), encoding); encoding.encode = () => "0000"; obs.text = String(v); break; }
    case "external": {
      const v = build(input.value, ctx);
      const out = timed(() => external(v, access as ValueAccess<unknown>, limits));
      obs.encodesBeforeText = obs.encodes; obs.value = out; obs.frozen = deepFrozen(out); obs.authenticated = typeof out === "object" && out !== null && !json.isDecimal(out) && !json.isEncoded(out) ? isAuthenticated(out) : undefined; obs.sharesRoot = out === v;
      if (c.expect.text !== undefined) obs.text = json.stringify(out);
      break;
    }
    case "externalMeta": { const v = build(input.value, ctx) as json.Encoded; const out = timed(() => external(v, access as ValueAccess<unknown>)) as json.Encoded; obs.isBase64 = out.encoding === json.BASE64; obs.byteLength = out.byteLength; obs.length = out.length; obs.sameLeaf = out === v; obs.sameEncoding = out.encoding === v.encoding; if (c.expect.text !== undefined) obs.text = String(out); break; }
    case "adapterRoundTripEqual": {
      const { root, access: adapter, state } = adapters.wrappedShippedHex!();
      const original = state!.original as json.Encoded;
      const imported = external(root, adapter) as json.Encoded;
      obs.sameLeaf = imported === original; obs.sameEncoding = imported.encoding === original.encoding;
      obs.value = timed(() => json.equal(original, imported));
      break;
    }
    case "externalRoundTripEqual": { const v = build(input.value, ctx) as json.Encoded; const out = external(v, access as ValueAccess<unknown>) as json.Encoded; obs.sameLeaf = out === v; obs.value = timed(() => json.equal(v, out)); break; }
    case "externalAdapter": {
      const { root, access: adapter, state } = adapters[input.adapter as string]!();
      try { obs.text = timed(() => { const out = external(root, adapter, limits) as json.Encoded; obs.isBase64 = out.encoding === json.BASE64; return String(out); }); }
      finally { Object.assign(obs, state); }
      break;
    }
    case "importedEncodingLength": {
      const { root, access: adapter, state } = adapters.foreignHex!();
      const imported = external(root, adapter) as json.Encoded;
      try { timed(() => json.encoded(Uint8Array.of(7, 8, 9), imported.encoding)); }
      finally { Object.assign(obs, state); }
      break;
    }
    case "copyBytesInto": { const v = build(input.value, ctx) as json.Encoded; obs.copied = timed(() => access.deferredString!(v)!.copyBytesInto(new Uint8Array(v.byteLength))); break; }
    case "accessKind": obs.value = access.kind(build(input.value, ctx) as json.Value); break;
    case "detached": {
      switch (input.entry) {
        case "base64": json.base64(detachedBytes([1, 2, 3])); break;
        case "encoded": json.encoded(detachedBytes([1, 2, 3]), hex); break;
        case "BASE64.length": json.BASE64.length(detachedBytes([1, 2, 3])); break;
        case "BASE64.encode": json.BASE64.encode(detachedBytes([1, 2, 3])); break;
        case "copyBytesInto": access.deferredString!(json.base64(Uint8Array.of(1, 2, 3)))!.copyBytesInto(detachedBytes([0, 0, 0])); break;
        case "lengthCallbackDetaches": { const source = Uint8Array.of(1, 2); json.encoded(source, { length: b => { (b.buffer as ArrayBuffer & { transfer(): ArrayBuffer }).transfer(); return 4; }, encode: hexText }); break; }
        default: throw new Error(`unknown entry ${String(input.entry)}`);
      }
      break;
    }
    case "stickyEncode": {
      let calls = 0;
      const flaky: json.Encoding = { length: () => 4, encode: () => (++calls === 1 ? "x" : "abcd") };
      const v = json.encoded(Uint8Array.of(251, 255), flaky);
      obs.first = codeOf(() => String(v));
      let path: unknown;
      try { json.stringify({ a: [v] }); } catch (error) { obs.second = (error as json.ValueError).code; path = (error as json.ValueError).details?.path; }
      obs.path = path; obs.calls = calls;
      break;
    }
    case "forge": {
      const Leaf = input.leaf === "Decimal" ? json.Decimal : json.Encoded;
      if (input.how === "construct") {
        const Ctor = Leaf as unknown as new (...args: unknown[]) => unknown;
        obs.value = input.leaf === "Decimal" ? new Ctor(rawJSON("1.5"), Symbol()) : new Ctor(Uint8Array.of(1), 4, json.BASE64, json.BASE64.encode, Symbol());
        break;
      }
      const forged = Object.create(Leaf.prototype) as object;
      obs.isLeaf = input.leaf === "Decimal" ? json.isDecimal(forged) : json.isEncoded(forged);
      obs.instanceOf = forged instanceof Leaf;
      obs.stringError = codeOf(() => String(forged));
      obs.stringifyError = codeOf(() => json.stringify({ n: forged as json.Value }));
      break;
    }
    case "protoMember": {
      const v = json.parse<Record<string, unknown>>(input.text as string);
      const out = walk(input.via as string, v, undefined) as Record<string, unknown>;
      obs.ownProto = Object.hasOwn(out, "__proto__"); obs.plainPrototype = Object.getPrototypeOf(out) === Object.prototype;
      obs.text = (() => { try { return json.stringify(out as json.Value); } catch (error) { return `refused: ${(error as json.ValueError).code}`; } })();
      break;
    }
    case "retired": {
      const n = new json.JSONNumber("0.1");
      obs.value = json.compareNumberTokens("1", "2") === -1 && json.integerNumberToken("1e2") && json.multipleNumberTokens("10", "5")
        && new json.JSONCapabilityError("x") instanceof RangeError && json.cloneValueGraph({ a: [1] }).a[0] === 1 && new json.JSONValueSet([1]).has(1)
        && json.equalJSON(n, json.parseJSON("0.10")) && json.numberToken(n) === "0.1" && json.stringifyJSON(json.cloneJSON({ n })) === "{\"n\":0.1}"
        && json.isJSONNumber(n) && (json.assertJSONValue({ a: 1 }), true);
      break;
    }
    case "authenticateGraph": {
      const v = build(input.value, ctx);
      const out = authenticateGraph(v);
      obs.same = out === v; obs.frozen = deepFrozen(out); obs.authenticatedAll = allAuthenticated(out); obs.admitIdentity = admit(out) === out;
      break;
    }
    case "admitBudget": { const first = admit(build(input.value, ctx)); admit(first, limits); break; }
    case "viaWalk": { const v = build(input.value, ctx), second = input.via === "equal" ? build(input.value, ctx) : undefined; obs.value = walk(input.via as string, v, second); break; }
    case "sharedRegistry": obs.value = isAuthenticated(external({ a: 1 }, access as ValueAccess<unknown>)) && json.isDecimal((external({ n: json.number("0.5") }, access as ValueAccess<unknown>) as { n: unknown }).n); break;
    case "sizeOf": { const v = build(input.value, ctx) as json.Value; obs.value = timed(() => sizeOf(v, limits)); break; }
    case "errorShape": { try { json.number("x"); } catch (error) { obs.name = (error as Error).name; obs.isError = error instanceof Error && error instanceof json.ValueError && (error as json.ValueError).code === "ERR_JSON_SYNTAX"; } break; }
    case "metadataBesideAttachment": {
      const bytes = new Uint8Array(input.size as number); bytes[0] = 255;
      const record = { body: json.base64(bytes), metadata: { size: bytes.length } };
      timed(() => { obs.byteLength = record.body.byteLength; obs.length = record.body.length; expect(record.metadata.size).toBe(bytes.length); });
      break;
    }
    case "presence": { const v = json.parse<Record<string, unknown>>(input.text as string); obs.value = Object.fromEntries((input.keys as string[]).map(key => [key, Object.hasOwn(v, key)])); break; }
    case "admit": {
      const v = build(input.value, ctx);
      const out = timed(() => admit(v, limits));
      obs.value = out; obs.frozen = deepFrozen(out); obs.authenticated = typeof out === "object" && out !== null ? isAuthenticated(out) : undefined;
      if (typeof v === "object" && v !== null && typeof out === "object" && out !== null) { obs.sharesLeaf = (out as Record<string, unknown>).a === (v as Record<string, unknown>).a; obs.sharesRoot = out === v; }
      break;
    }
    case "admitTwice": { const first = admit(build(input.value, ctx)); obs.same = admit(first) === first; break; }
    case "authenticateMutable": authenticate({}); break;
    default: throw new Error(`unknown op ${c.op}`);
  }
  return obs;
}

describe("value-api-shape case table", () => {
  it("table integrity: declared case count, unique ids, every case asserts something", () => {
    const ids = table.cases.map(c => c.id);
    expect(table.cases.length).toBe(table.caseCount);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of table.cases as Case[]) expect(Object.keys(c.expect).length, `${c.id} has no expectation`).toBeGreaterThan(0);
  });
  for (const c of table.cases as Case[]) {
    const skip = (c.languages !== undefined && !c.languages.includes("typescript")) || (c.runtime === "rawJSON-native" && typeof nativeJSON.rawJSON !== "function");
    it.skipIf(skip)(`${c.id}: ${c.description}`, () => {
      if (Object.keys(c.expect).length === 0) throw new Error(`${c.id} has no expectation`);
      const ctx: Context = { getterRan: false, hookRan: false, encoderCalls: 0 };
      const expected = c.expect;
      if (typeof expected.error === "string") {
        let caught: unknown;
        const obs: Record<string, unknown> = {};
        try { run(c, ctx, obs); } catch (error) { caught = error; }
        expect(caught, "expected a ValueError").toBeInstanceOf(json.ValueError);
        const error = caught as json.ValueError;
        expect(error.name).toBe("ValueError");
        expect(error.code).toBe(expected.error);
        if (expected.path !== undefined) expect(error.details?.path).toBe(expected.path);
        if (expected.details !== undefined) expect(error.details).toMatchObject(expected.details as Record<string, unknown>);
        if (expected.cause !== undefined) expect((error.cause as Error).message).toBe(expected.cause);
        if (expected.messageIncludes !== undefined) expect(error.message).toContain(expected.messageIncludes);
        if (expected.messageExcludes !== undefined) expect(error.message).not.toContain(expected.messageExcludes);
        if (expected.getterRan !== undefined) expect(ctx.getterRan).toBe(expected.getterRan);
        if (expected.hookRan !== undefined) expect(ctx.hookRan).toBe(expected.hookRan);
        for (const [key, value] of Object.entries(expected)) {
          if (["error", "path", "details", "cause", "messageIncludes", "messageExcludes", "getterRan", "hookRan"].includes(key)) continue;
          if (key === "encoderCalls") expect(ctx.encoderCalls + ((obs.encoderCalls as number | undefined) ?? 0), key).toBe(value);
          else expect(obs[key], key).toEqual(value);
        }
        return;
      }
      const obs: Record<string, unknown> = {};
      run(c, ctx, obs);
      for (const [key, value] of Object.entries(expected)) {
        if (key === "value") matches(obs.value, value, "value");
        else if (key === "getterRan") expect(ctx.getterRan).toBe(value);
        else if (key === "encoderCalls") expect((obs.encoderCalls as number | undefined) ?? ctx.encoderCalls, key).toBe(value);
        else expect(obs[key], key).toEqual(literal(value));
      }
    });
  }
});

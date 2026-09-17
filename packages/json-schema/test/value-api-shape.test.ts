// Executes test/value-api-shape.cases.json through the package's public entry,
// reached only by its public specifier so that a per-package run (aliased to
// src) and a workspace-root run (resolved to dist) exercise one installation
// each. The table is language-neutral; this file is its TypeScript runner.
import { describe, expect, it } from "vitest";
import * as json from "@openbindings/json";
import { access, counters, external } from "@openbindings/json/advanced";
import type { DeferredStringStorage, ValueAccess, ValueKind } from "@openbindings/json/advanced";
import { retain } from "@openbindings/json/values";
import {
  compile, compileSchema, compileValueSchema, valueInstance, EXACT_DRAFT_2020, RETAINED_DRAFT_2020,
} from "@openbindings/json-schema";
import type { CompileOptions, Validation } from "@openbindings/json-schema";
import table from "./value-api-shape.cases.json";

interface Case {
  readonly id: string;
  readonly description: string;
  readonly op: "validate" | "compile" | "retired";
  readonly input: {
    readonly schema?: unknown;
    readonly value?: unknown;
    readonly options?: Record<string, unknown>;
    readonly times?: number;
    readonly access?: string;
    readonly mutateAfterCompile?: { pointer: string; value: unknown };
    readonly priorWork?: boolean;
  };
  readonly expect: Record<string, unknown>;
  readonly languages?: readonly string[];
}

interface Context { getterRan: boolean; hookRan: boolean; encoderCalls: number; scalarReasons: string[] }
const context = (): Context => ({ getterRan: false, hookRan: false, encoderCalls: 0, scalarReasons: [] });

const hexText = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const hexEncode = (ctx: Context) => (bytes: Uint8Array): string => { ctx.encoderCalls++; return hexText(bytes); };

// Host-side wrappers the foreign adapters serve. Never leaves of this installation.
class Foreign {
  readonly bytes: Uint8Array;
  constructor(readonly leaf: json.Encoded) { this.bytes = leaf.bytes(); } // the host's own copy, taken before any measured call
}
class ForeignText { constructor(readonly text: string) {} }
class ForeignNumber { constructor(readonly token: string) {} }

// Recipe names; any other "$" key ($ref, $id, $defs) is a schema keyword.
const recipes = new Set(["$decimal", "$number", "$native", "$base64", "$base64Zeros", "$base64ThenMutate", "$hex", "$bigDecimal", "$nest", "$external",
  "$foreign", "$foreignText", "$foreignNumber", "$undefined", "$nan", "$accessor", "$cycle", "$host", "$rawjson", "$rawOnly", "$toJSON", "$hole"]);

function build(recipe: unknown, ctx: Context): unknown {
  if (recipe === null || typeof recipe !== "object") return recipe;
  if (Array.isArray(recipe)) return recipe.map(item => build(item, ctx));
  const r = recipe as Record<string, unknown>, keys = Object.keys(r);
  if (keys.length === 1 && recipes.has(keys[0]!)) {
    const arg = r[keys[0]!];
    switch (keys[0]) {
      case "$decimal": { const value = json.number(arg as string); if (!json.isDecimal(value)) throw new Error(`${arg} is not a Decimal`); return value; }
      case "$number": return json.number(arg as string);
      case "$native": return arg as number;
      case "$base64": return json.base64(Uint8Array.from(arg as number[]));
      case "$base64Zeros": return json.base64(new Uint8Array(arg as number));
      case "$base64ThenMutate": { const bytes = Uint8Array.from(arg as number[]); const value = json.base64(bytes); bytes.fill(9); return value; }
      case "$hex": return json.encoded(Uint8Array.from(arg as number[]), { length: b => b.length * 2, encode: hexEncode(ctx) });
      case "$bigDecimal": return json.number("1" + "0".repeat((arg as number) - 1));
      case "$nest": { let nested: unknown = 0; for (let i = 0; i < (arg as number); i++) nested = [nested]; return nested; }
      case "$external": return external(build(arg, ctx) as json.Value, access);
      case "$foreign": return new Foreign(build(arg, ctx) as json.Encoded);
      case "$foreignText": return new ForeignText(arg as string);
      case "$foreignNumber": return new ForeignNumber(arg as string);
      case "$undefined": return undefined;
      case "$nan": return NaN;
      case "$accessor": return Object.defineProperty({}, "x", { enumerable: true, get() { ctx.getterRan = true; return 1; } });
      case "$cycle": { const cycle: Record<string, unknown> = { a: 1 }; cycle.self = cycle; return cycle; }
      case "$host": return new Date(0);
      case "$rawjson": return rawToken();
      case "$rawOnly": return { raw: rawToken() };
      case "$toJSON": return { toJSON() { ctx.hookRan = true; return 1; } };
      // eslint-disable-next-line no-sparse-arrays -- a deliberate hole
      case "$hole": return [, 1];
      default: throw new Error(`unknown recipe ${keys[0]}`);
    }
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = build(r[key], ctx);
  return out;
}

/** A genuine rawJSON token object, taken from a Decimal that holds one. */
function rawToken(): unknown {
  return (json.number("1e400") as json.Decimal).raw;
}

function memberAt(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  let current = root;
  for (const segment of pointer.slice(1).split("/")) {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    current = Array.isArray(current) ? current[Number(key)] : (current as Record<string, unknown>)[key];
  }
  return current;
}

function setAt(root: unknown, pointer: string, value: unknown): void {
  const segments = pointer.slice(1).split("/");
  const last = segments.pop()!;
  const parent = memberAt(root, segments.length ? "/" + segments.join("/") : "") as Record<string, unknown>;
  parent[last] = value;
}

type Counters = Record<string, number>;
function flat(costs: json.Costs): Counters {
  const out: Counters = {};
  for (const [key, value] of Object.entries(costs)) {
    if (key === "forcing") for (const [reason, bytes] of Object.entries(value as Record<string, number>)) out[`forcing.${reason}`] = bytes;
    else out[key] = value as number;
  }
  return out;
}
function delta(before: Counters, after: Counters): Counters {
  const out: Counters = {};
  for (const key of Object.keys(before)) out[key] = after[key]! - before[key]!;
  return out;
}

function adapter(name: string, ctx: Context): ValueAccess<unknown> {
  const shipped = access as ValueAccess<unknown>;
  switch (name) {
    case "shipped": return shipped;
    case "foreign": return {
      version: 1,
      kind: v => v instanceof Foreign ? "string" : v instanceof ForeignNumber ? "number" : shipped.kind(v),
      get: (v, k) => shipped.get(v, k),
      keys: v => shipped.keys(v),
      length: v => v instanceof Foreign ? v.leaf.length : shipped.length(v),
      numberToken: v => v instanceof ForeignNumber ? v.token : shipped.numberToken(v),
      scalar: (v, reason) => shipped.scalar(v, reason),
      deferredString: (v): DeferredStringStorage | undefined => {
        if (!(v instanceof Foreign)) return undefined;
        const { bytes } = v;
        return {
          byteLength: bytes.byteLength, length: v.leaf.length,
          encode: v.leaf.encoding === json.BASE64 ? json.BASE64.encode : hexEncode(ctx),
          copyBytesInto: destination => { destination.set(bytes); return bytes.byteLength; },
        };
      },
    };
    case "scalar": return {
      version: 1,
      kind: (v): ValueKind => v instanceof ForeignText ? "string" : shipped.kind(v),
      get: (v, k) => shipped.get(v, k),
      keys: v => shipped.keys(v),
      length: v => v instanceof ForeignText ? [...v.text].length : shipped.length(v),
      numberToken: v => shipped.numberToken(v),
      scalar: (v, reason) => { if (v instanceof ForeignText) { ctx.scalarReasons.push(String(reason)); return v.text; } return shipped.scalar(v, reason); },
    };
    case "kindThrows": return { ...shipped, kind: () => { throw new Error("adapter failed"); } };
    case "badVersion": return { ...shipped, version: 2 } as unknown as ValueAccess<unknown>;
    default: throw new Error(`unknown adapter ${name}`);
  }
}

function retired(): boolean {
  const legacy = compileValueSchema({ type: "string", minLength: 4, maxLength: 4 });
  const value = retain("AQID");
  const ok1 = legacy.validate(value).valid;
  const instance = valueInstance(value);
  const ok2 = compileSchema({ const: "AQID" }, { drafts: [RETAINED_DRAFT_2020] }).validate(instance).valid;
  const ok3 = compileSchema({ const: json.parseJSON("9007199254740993") }, { drafts: [EXACT_DRAFT_2020] }).validate(json.parseJSON("9007199254740993")).valid;
  return ok1 && ok2 && ok3;
}

describe("value-api-shape case table (json-schema)", () => {
  const cases = table.cases as unknown as Case[];
  it("declares its size and every case has an id and an expectation", () => {
    expect(cases.length).toBe(table.caseCount);
    expect(new Set(cases.map(c => c.id)).size).toBe(cases.length);
    for (const c of cases) expect(Object.keys(c.expect).length, c.id).toBeGreaterThan(0);
  });
  for (const c of cases) {
    if (c.languages && !c.languages.includes("typescript")) continue;
    it(`${c.id}: ${c.description}`, () => {
      const ctx = context(), e = c.expect;
      if (Object.keys(e).length === 0) throw new Error("empty expectation");
      if (c.op === "retired") { expect(retired()).toBe(e.works); return; }
      const schema = build(c.input.schema, ctx) as json.Value;
      const options = c.input.options as CompileOptions | undefined;
      let thrown: unknown, compiled: ReturnType<typeof compile> | undefined, validation: Validation | undefined;
      let counted: Counters;
      const value = c.op === "validate" ? build(c.input.value, ctx) : undefined;
      const adapt = c.input.access ? adapter(c.input.access, ctx) : undefined;
      if (c.input.priorWork) String(json.base64(Uint8Array.of(1, 2, 3)));
      if (c.op === "compile") {
        const before = flat(counters());
        try { compiled = compile(schema, options); } catch (error) { thrown = error; }
        counted = delta(before, flat(counters()));
      } else {
        compiled = compile(schema, options);
        if (c.input.mutateAfterCompile) setAt(schema, c.input.mutateAfterCompile.pointer, c.input.mutateAfterCompile.value);
        const before = flat(counters());
        try {
          for (let i = 0; i < (c.input.times ?? 1); i++) {
            const start = flat(counters());
            validation = adapt ? compiled.validate(value, adapt) : compiled.validate(value as json.Value);
            // Every report's costs are exactly the work of its own call.
            expect(flat(validation.costs), `costs of call ${i + 1}`).toEqual(delta(start, flat(counters())));
          }
        } catch (error) { thrown = error; }
        counted = delta(before, flat(counters()));
      }
      for (const [key, expected] of Object.entries(e)) {
        switch (key) {
          case "compiled": expect(thrown, "threw").toBeUndefined(); expect(compiled !== undefined).toBe(expected); break;
          case "error":
            expect(thrown, "no error was thrown").toBeDefined();
            expect(thrown instanceof json.ValueError, `not a ValueError: ${String(thrown)}`).toBe(true);
            expect((thrown as json.ValueError).code).toBe(expected);
            break;
          case "throws":
            expect(thrown, "no error was thrown").toBeDefined();
            expect(thrown instanceof Error && !(thrown instanceof json.ValueError), `not the library's error: ${String(thrown)}`).toBe(true);
            break;
          case "path": expect((thrown as json.ValueError).details?.path).toBe(expected); break;
          case "details": expect((thrown as json.ValueError).details).toMatchObject(expected as object); break;
          case "causeMessage": expect(((thrown as json.ValueError).cause as Error).message).toBe(expected); break;
          case "valid": expect(thrown, `threw ${String(thrown)}`).toBeUndefined(); expect(validation!.valid).toBe(expected); break;
          case "codes": expect(validation!.errors.map(x => x.code)).toEqual(expected); break;
          case "pointers": expect(validation!.errors.map(x => x.data.pointer)).toEqual(expected); break;
          case "messageIncludes": expect(thrown ? (thrown as Error).message : validation!.errors[0]!.message).toContain(expected); break;
          case "messageExcludes": expect(thrown ? (thrown as Error).message : validation!.errors[0]!.message).not.toContain(expected); break;
          case "valueIs": expect(validation!.errors[0]!.data.value === memberAt(value, expected as string), `data.value is not the member at ${String(expected)}`).toBe(true); break;
          case "kept": {
            const { pointer, text } = expected as { pointer: string; text: string };
            const before = flat(counters());
            expect(String(memberAt(value, pointer))).toBe(text);
            expect(delta(before, flat(counters())).encodes).toBe(0);
            break;
          }
          case "getterRan": expect(ctx.getterRan).toBe(expected); break;
          case "hookRan": expect(ctx.hookRan).toBe(expected); break;
          case "encoderCalls": expect(ctx.encoderCalls).toBe(expected); break;
          case "scalarReasons": expect(ctx.scalarReasons).toEqual(expected); break;
          case "frozen": expect(Object.isFrozen(validation) && Object.isFrozen(validation!.errors)).toBe(expected); break;
          default:
            if (!(key in counted!)) throw new Error(`unknown expectation ${key}`);
            expect(counted![key], key).toBe(expected);
        }
      }
    });
  }
});

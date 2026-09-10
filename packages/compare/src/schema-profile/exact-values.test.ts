import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { equalNormalizedSchemas } from "./identity.js";
import { parseJSON, isJSONNumber } from "../../../json/src/index.js";
import { Normalizer } from "./normalize.js";
import { inputCompatible, outputCompatible } from "./compat.js";
import { OutsideProfileError, SchemaError } from "./errors.js";

// Test-only exact-carriage candidate, not new runtime wiring/dependencies.
// These are optional profile tests; red is real, not an expected-failure mode.
type Doc = { operations: Record<string, Record<string, unknown>> };
type Case = {
  id: string;
  rule: string;
  mode: "subsume" | "identical";
  direction: "input" | "output";
  leftJSON: string;
  rightJSON: string;
  expected: { verdict?: string; error?: string };
  numberTokens: { left: string[]; right: string[] };
  reason?: string;
  leftUnionConstOrder?: string[];
};

function token(value: unknown): string {
  return isJSONNumber(value) ? value.rawJSON : String(value);
}

function decode(raw: string, expected: string[]): Doc {
  const value = parseJSON(raw);
  const got: string[] = [];
  const walk = (v: unknown): void => {
    if (isJSONNumber(v) || typeof v === "number") {
      got.push(token(v));
      return;
    }
    if (v && typeof v === "object") {
      for (const child of Object.values(v)) walk(child);
    }
  };
  walk(value);
  // Equivalent zero is permitted by the value model. All other ingress
  // spellings are retained by this exact fixture decoder.
  expect(got.sort()).toEqual(expected.map(t => t === "-0" ? "0" : t).sort());
  return value as unknown as Doc;
}

async function normalizeCase(c: Case) {
  const left = decode(c.leftJSON, c.numberTokens.left);
  const right = decode(c.rightJSON, c.numberTokens.right);
  const nl = new Normalizer({ root: left as unknown as Record<string, unknown> });
  const nr = new Normalizer({ root: right as unknown as Record<string, unknown> });
  return [
    await nl.normalize(left.operations.test![c.direction] as Record<string, unknown>),
    await nr.normalize(right.operations.test![c.direction] as Record<string, unknown>),
  ] as const;
}

const dir = process.env.OB_INTERFACES_CORPUS ?? resolve(
  dirname(fileURLToPath(import.meta.url)), "../../../../../interfaces/conformance",
);
const path = join(dir, "comparison/manifest.json");
if (!existsSync(path) && process.env.OB_CORPUS_REQUIRED) {
  throw new Error("comparison-profile corpus required but absent");
}
const manifest = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
if (manifest && manifest.exactValues !== "exact-values.json") {
  throw new Error("missing required exact-value fixture pack");
}
const pack = manifest
  ? JSON.parse(readFileSync(join(dir, "comparison", manifest.exactValues), "utf8"))
  : null;
if (pack && (pack.scope !== "comparison-profile" || pack.profile !== "OB-2020-12"
  || pack.profileVersion !== "0.1" || !pack.cases.length)) {
  throw new Error("invalid comparison-profile corpus identity");
}
const cases = (pack?.cases ?? []) as Case[];

describe.skipIf(!pack)("comparison-profile conformance — exact values (not Core)", () => {
  for (const c of cases) it(c.id, async () => {
    if (c.expected.error === "schema") {
      await expect(normalizeCase(c)).rejects.toBeInstanceOf(SchemaError);
      return;
    }
    if (c.expected.verdict === "indeterminate") {
      await expect(normalizeCase(c)).rejects.toBeInstanceOf(OutsideProfileError);
      return;
    }
    const [a, b] = await normalizeCase(c);
    if (c.leftUnionConstOrder) {
      expect((a.anyOf as { const: unknown }[]).map(v => token(v.const)))
        .toEqual(c.leftUnionConstOrder);
    }
    let compatible: boolean;
    let reason: string | undefined;
    if (c.mode === "identical") {
      compatible = equalNormalizedSchemas(a, b);
    } else {
      const result = c.direction === "input" ? inputCompatible(a, b) : outputCompatible(a, b);
      compatible = result.compatible;
      reason = result.reason;
    }
    expect(compatible ? "compatible" : "incompatible", c.rule).toBe(c.expected.verdict);
    if (c.reason) expect(reason?.startsWith(c.reason.split(":")[0] + ":")).toBe(true);
  });
});

describe.skipIf(!pack)("official SDK qualification — exact comparison diagnostics (not Core)", () => {
  for (const c of cases.filter(c => c.reason)) it(c.id, async () => {
    const [a, b] = await normalizeCase(c);
    const result = c.direction === "input" ? inputCompatible(a, b) : outputCompatible(a, b);
    expect(result.reason).toBe(c.reason);
  });
});

import { expect, it } from "vitest";
import rawJSON from "core-js-pure/actual/json/raw-json.js";
import { cloneValueGraph, JSONNumber, stringifyJSON } from "./index.js";

it("detaches owned graphs with aliases, cycles and optional metadata", () => {
  const shared = { n: new JSONNumber("9007199254740993"), optional: undefined };
  const source: unknown[] = [shared, shared]; source.push(source);
  const out = cloneValueGraph(source);
  expect(out).not.toBe(source); expect(out[0]).not.toBe(shared);
  expect(out[0]).toBe(out[1]); expect(out[2]).toBe(out);
  expect((out[0] as typeof shared).optional).toBeUndefined();
  expect(stringifyJSON((out[0] as typeof shared).n)).toBe("9007199254740993");
});

it("does not smuggle incompatible raw carriers or host computations into a graph", () => {
  for (const value of [rawJSON("true"), () => 1, Symbol("x"), 1n, Infinity, NaN]) {
    expect(() => cloneValueGraph({ value })).toThrow();
  }
  let calls = 0;
  const source = { get value() { calls++; return 1; } };
  expect(() => cloneValueGraph(source)).toThrow("accessor");
  expect(calls).toBe(0);
});

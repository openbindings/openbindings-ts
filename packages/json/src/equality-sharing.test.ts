import { describe, expect, it } from "vitest";
import { base64, encoded, equal, number, ValueError } from "./index.js";
import type { Value } from "./index.js";

describe("equality with shared graphs", () => {
  it("does not confuse cross-operand overlap with cycles", () => {
    const shared = { n: { n: 1 } };
    expect(equal({ n: shared }, shared)).toBe(false);
    expect(equal(shared, { n: shared })).toBe(false);
    const array = [[1]];
    expect(equal([array], array)).toBe(false);
    expect(equal(array, [array])).toBe(false);
  });
  it("compares shared DAGs by logical content", () => {
    for (let depth = 0; depth < 12; depth++) {
      let a: Value = 1, b: Value = 1;
      for (let i = 0; i < depth; i++) { a = [a, a]; b = [b, b]; }
      expect(equal(a, b)).toBe(true);
      expect(equal({ a, b }, { a: b, b: a })).toBe(true);
      expect(equal({ a, b: 1 }, { a: b, b: 2 })).toBe(false);
    }
  });
  it("continues to reject cycles reached during traversal", () => {
    const a: Record<string, Value> = {}, b: Record<string, Value> = {};
    a.child = a; b.child = b;
    expect(() => equal(a, b)).toThrow(ValueError);
  });
  it("retains exact and representation-aware leaf comparisons", () => {
    expect(equal(number("9007199254740993"), number("9007199254740992"))).toBe(false);
    expect(equal(number("0.10"), number("0.1"))).toBe(true);
    const a = base64(Uint8Array.of(1));
    expect(equal({ a, b: a }, { a, b: base64(Uint8Array.of(1)) })).toBe(true);
    const encoding = { length: () => 1, encode: () => "x" };
    expect(equal(encoded(Uint8Array.of(1), encoding), encoded(Uint8Array.of(2), encoding))).toBe(true);
    expect(equal(a, encoded(Uint8Array.of(1), encoding))).toBe(false);
  });
});

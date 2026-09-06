import rawCanonicalize from "canonicalize";
import { describe, expect, it } from "vitest";
import { canonicalize, canonicalizedValue } from "./canonical-json.js";

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomJSON(random: () => number, depth = 0): unknown {
  const kind = depth >= 4 ? Math.floor(random() * 4) : Math.floor(random() * 6);
  switch (kind) {
    case 0: return null;
    case 1: return random() < 0.5;
    case 2: return Math.round((random() - 0.5) * 1_000_000) / 100;
    case 3: return ["plain", "é", "\u0000", "𝄞", "line\nfeed"][Math.floor(random() * 5)];
    case 4: {
      const length = Math.floor(random() * 5);
      return Array.from({ length }, () => randomJSON(random, depth + 1));
    }
    default: {
      const keys = ["z", "a", "10", "2", "é", "𝄞", `k${Math.floor(random() * 20)}`];
      const object: Record<string, unknown> = {};
      const length = Math.floor(random() * keys.length);
      for (let index = 0; index < length; index++) {
        object[keys[Math.floor(random() * keys.length)]!] = randomJSON(random, depth + 1);
      }
      return object;
    }
  }
}

describe("canonicalize", () => {
  it("matches the previously qualified RFC 8785 implementation over deterministic generated JSON", () => {
    const random = generator(0x0b1_020);
    for (let index = 0; index < 2_000; index++) {
      const value = randomJSON(random);
      expect(canonicalize(value)).toBe(rawCanonicalize(value));
    }
  });

  it("preserves JSON array normalization, toJSON, and unsupported-root behavior", () => {
    expect(canonicalize([undefined, Symbol("x"), -0])).toBe("[null,null,0]");
    expect(canonicalize({ z: 1, omitted: undefined, a: 2 })).toBe('{"a":2,"z":1}');
    expect(canonicalize({ toJSON: () => ({ b: 1, a: 2 }) })).toBe('{"a":2,"b":1}');
    expect(canonicalize(undefined)).toBeUndefined();
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("normalizes unsupported members exactly like canonical JSON", () => {
    expect(canonicalize({ fn() {}, array: [() => undefined] }))
      .toBe('{"array":[null]}');
  });

  it("returns a graph exactly described by its canonical bytes", () => {
    const random = generator(0xc01d_f00d);
    for (let index = 0; index < 2_000; index++) {
      const prepared = canonicalizedValue(randomJSON(random));
      expect(prepared).toBeDefined();
      expect(prepared!.snapshot).toEqual(JSON.parse(prepared!.canonical));
    }

    const prepared = canonicalizedValue({ zero: -0, "10": 10, "2": 2 })!;
    expect(Object.is((prepared.snapshot as { zero: number }).zero, -0)).toBe(false);
    expect(prepared.requiresManualOrdering).toBe(true);
    expect(prepared.canonical).toBe('{"10":10,"2":2,"zero":0}');

    const stateful = {
      calls: 0,
      toJSON() {
        this.calls++;
        return { value: this.calls };
      },
    };
    const stable = canonicalizedValue(stateful)!;
    expect(stateful.calls).toBe(1);
    expect(stable.canonical).toBe('{"value":1}');
    expect(stable.snapshot).toEqual({ value: 1 });
  });
});

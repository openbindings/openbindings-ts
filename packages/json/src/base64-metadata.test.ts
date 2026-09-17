import { describe, expect, it } from "vitest";
import { BASE64, base64, encoded, equal, stringify, ValueError } from "./index.js";
import { access, counters, external } from "./advanced.js";

describe("known Base64 encoding metadata", () => {
  it("rejects inconsistent lengths before copying or encoding", () => {
    for (const size of [0, 1, 2, 3, 4, 64]) {
      const bytes = new Uint8Array(size), length = Math.ceil(size / 3) * 4;
      for (const wrong of [length + 1, ...(length ? [length - 1] : [])]) {
        const before = counters();
        expect(() => encoded(bytes, { length: () => wrong, encode: BASE64.encode })).toThrowError(ValueError);
        expect(() => encoded(bytes, { length: () => wrong, encode: BASE64.encode })).toThrowError(/Base64.*length/);
        expect(counters().bytesCopied).toBe(before.bytesCopied);
        expect(counters().encodes).toBe(before.encodes);
      }
    }
  });
  it("keeps valid custom objects using the known encoder deferred and consistent", () => {
    for (const size of [0, 1, 2, 3, 4, 64]) {
      const bytes = new Uint8Array(size).fill(251), encoding = { ...BASE64 };
      const value = encoded(bytes, encoding), direct = base64(bytes);
      const before = counters();
      expect(value.encoding).toBe(encoding);
      expect(equal(value, direct)).toBe(true);
      expect(counters().encodes).toBe(before.encodes);
      bytes.fill(0);
      expect(value.bytes()).toEqual(new Uint8Array(size).fill(251));
      expect([...String(value)]).toHaveLength(value.length);
      expect(stringify(value)).toBe(stringify(direct));
    }
  });
  it("keeps foreign storage's known-encoding consistency check", () => {
    const leaf = base64(Uint8Array.of(1));
    const storage = access.deferredString!(leaf)!;
    const adapter = { ...access, kind: () => "string" as const, length: () => 1,
      deferredString: () => ({ ...storage, length: 1 }) };
    expect(() => external("foreign", adapter)).toThrowError(/Base64.*length/);
  });
  it("does not attach the Base64 formula to other encodings", () => {
    const hex = encoded(Uint8Array.of(251), { length: () => 2, encode: () => "fb" });
    const empty = encoded(Uint8Array.of(1), { length: () => 0, encode: () => "" });
    expect(String(hex)).toBe("fb");
    expect(String(empty)).toBe("");
    const wrong = encoded(Uint8Array.of(1), { length: () => 1, encode: b => BASE64.encode(b) });
    expect(() => String(wrong)).toThrowError(/length/);
  });
});

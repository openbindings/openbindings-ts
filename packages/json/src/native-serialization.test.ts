import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

describe("Decimal native serialization capability", () => {
  it("writes exact tokens with the actual supporting serializer", async () => {
    const json = await import("./index.js");
    const value = json.parse('{"n":9007199254740993,"d":0.10}');
    expect(JSON.stringify(value)).toBe('{"n":9007199254740993,"d":0.10}');
    expect(json.stringify(value)).toBe('{"n":9007199254740993,"d":0.10}');
  });

  for (const mode of ["object", "throw"] as const) {
    it(`refuses when the host serializer would ${mode}, without disabling portable export`, async () => {
      vi.resetModules();
      const original = JSON.stringify;
      const probe = vi.spyOn(JSON, "stringify").mockImplementation(((value: unknown) => {
        if (typeof value === "object" && value !== null && "rawJSON" in value) {
          if (mode === "throw") throw new TypeError("unsupported raw token");
          return '{"rawJSON":"9007199254740993"}';
        }
        return original(value);
      }) as typeof JSON.stringify);
      const json = await import("./index.js");
      probe.mockRestore();
      const value = json.number("9007199254740993");
      expect(() => JSON.stringify({ value })).toThrowError(expect.objectContaining({
        code: "ERR_JSON_COERCION", details: { reason: "native-raw-json-unavailable" },
      }));
      expect(String(value)).toBe("9007199254740993");
      expect(json.stringify({ value })).toBe('{"value":9007199254740993}');
      expect(JSON.stringify(json.base64(Uint8Array.of(251, 255)))).toBe('"+/8="');
    });
  }
});

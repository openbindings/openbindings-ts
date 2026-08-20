import { describe, expect, it } from "vitest";
import { canonicalizeLocation, resolveRef, unknownFields } from "./uri.js";
import { parseDocument } from "./parse.js";

describe("canonicalizeLocation", () => {
  const cases: Array<[name: string, input: string, want: string]> = [
    ["lowercase scheme", "HTTPS://example.com/foo", "https://example.com/foo"],
    ["lowercase host", "https://Example.COM/Foo", "https://example.com/Foo"],
    ["path case preserved", "https://example.com/Foo/Bar", "https://example.com/Foo/Bar"],
    ["query case preserved", "https://example.com/x?Bar=Baz", "https://example.com/x?Bar=Baz"],
    ["empty path with authority", "https://example.com", "https://example.com/"],
    ["https default port stripped", "https://example.com:443/foo", "https://example.com/foo"],
    ["http default port stripped", "http://example.com:80/foo", "http://example.com/foo"],
    ["non-default port preserved", "https://example.com:8443/foo", "https://example.com:8443/foo"],
    ["fragment stripped", "https://example.com/foo#bar", "https://example.com/foo"],
    ["dot segments removed", "https://example.com/a/./b/../c", "https://example.com/a/c"],
    ["unreserved percent decoded", "https://example.com/foo%2Dbar", "https://example.com/foo-bar"],
    ["space stays encoded", "https://example.com/foo%20bar", "https://example.com/foo%20bar"],
    ["absolute filesystem path lifted", "/etc/passwd", "file:///etc/passwd"],
    ["trailing slash significant", "https://example.com/x/", "https://example.com/x/"],
    ["IDN punycoded", "https://bücher.example/x", "https://xn--bcher-kva.example/x"],
    ["IDN already punycoded", "https://xn--bcher-kva.example/x", "https://xn--bcher-kva.example/x"],
  ];

  for (const [name, input, want] of cases) {
    it(name, () => {
      expect(canonicalizeLocation(input)).toBe(want);
    });
  }

  it("rejects empty URI", () => {
    expect(() => canonicalizeLocation("")).toThrow(/empty URI/);
  });
  it("rejects URI without scheme or absolute path", () => {
    expect(() => canonicalizeLocation("no-scheme")).toThrow();
  });

  it("yields equal results for equivalent URIs", () => {
    const equal: Array<[string, string]> = [
      ["https://Example.com/foo", "https://example.com/foo"],
      ["https://example.com:443/foo", "https://example.com/foo"],
      ["https://example.com/a/./b/../c", "https://example.com/a/c"],
      ["https://example.com/foo#anchor", "https://example.com/foo"],
      ["https://example.com/foo%2Dbar", "https://example.com/foo-bar"],
    ];
    for (const [a, b] of equal) {
      expect(canonicalizeLocation(a)).toBe(canonicalizeLocation(b));
    }
  });

  it("yields distinct results for distinct URIs", () => {
    const distinct: Array<[string, string]> = [
      ["https://example.com/foo", "http://example.com/foo"],
      ["https://example.com/x", "https://example.com/x/"],
      ["https://example.com/Foo", "https://example.com/foo"],
      ["https://example.com/?a=1", "https://example.com/?a=2"],
      ["https://example.com/", "https://example.com:8443/"],
    ];
    for (const [a, b] of distinct) {
      expect(canonicalizeLocation(a)).not.toBe(canonicalizeLocation(b));
    }
  });
});

describe("resolveRef", () => {
  it("resolves directory-relative reference", () => {
    expect(
      resolveRef("https://example.com/interfaces/host.json", "./foo.json"),
    ).toBe("https://example.com/interfaces/foo.json");
  });

  it("resolves parent-directory reference", () => {
    expect(
      resolveRef("https://example.com/interfaces/host.json", "../other/foo.json"),
    ).toBe("https://example.com/other/foo.json");
  });

  it("resolves absolute-path reference", () => {
    expect(
      resolveRef("https://example.com/interfaces/host.json", "/foo.json"),
    ).toBe("https://example.com/foo.json");
  });

  it("returns absolute reference unchanged", () => {
    const ref = "https://other.example.com/foo.json";
    expect(resolveRef("https://example.com/interfaces/host.json", ref)).toBe(ref);
  });

  it("preserves JSON Pointer fragment on relative reference", () => {
    expect(
      resolveRef(
        "https://example.com/interfaces/host.json",
        "./foo.json#/components/schemas/Task",
      ),
    ).toBe("https://example.com/interfaces/foo.json#/components/schemas/Task");
  });

  it("resolves bare relative reference", () => {
    expect(resolveRef("https://example.com/a/b.json", "c.json")).toBe(
      "https://example.com/a/c.json",
    );
  });

  it("rejects empty ref", () => {
    expect(() => resolveRef("https://example.com/", "")).toThrow(/empty reference/);
  });
  it("rejects relative ref with empty base", () => {
    expect(() => resolveRef("", "./foo.json")).toThrow(/without a base/);
  });
  it("rejects non-absolute base", () => {
    expect(() => resolveRef("not/an/absolute/uri", "./foo.json")).toThrow();
  });
});

describe("unknownFields", () => {
  it("returns keys not in the known set", () => {
    const obj = { a: 1, b: 2, "x-vendor": 3 };
    expect(unknownFields(obj, ["a", "b"])).toEqual({ "x-vendor": 3 });
  });
  it("returns empty when all keys are known", () => {
    const obj = { a: 1, b: 2 };
    expect(unknownFields(obj, ["a", "b"])).toEqual({});
  });
  it("accepts a Set", () => {
    const obj = { a: 1, b: 2 };
    expect(unknownFields(obj, new Set(["a"]))).toEqual({ b: 2 });
  });
});

describe("parseDocument preserves unknown fields", () => {
  // OpenBindings 0.2.0 OBI-T-02 says tools must ignore unknown fields, and
  // OBI-T-03 says x-* fields are extensions. parseDocument's JSON.parse path
  // preserves all fields naturally; this test guards against a regression
  // where typed reconstruction would drop them.
  it("round-trips x- extensions and unknown fields verbatim", () => {
    const text = JSON.stringify({
      openbindings: "0.2.0",
      operations: {},
      "x-vendor-meta": { foo: "bar" },
      "x-internal": 42,
    });
    const iface = parseDocument(text);
    expect((iface as Record<string, unknown>)["x-vendor-meta"]).toEqual({ foo: "bar" });
    expect((iface as Record<string, unknown>)["x-internal"]).toBe(42);

    // Round-trip via JSON.stringify retains the extensions.
    const round = JSON.parse(JSON.stringify(iface));
    expect(round["x-vendor-meta"]).toEqual({ foo: "bar" });
    expect(round["x-internal"]).toBe(42);
  });

  it("survives object-spread modification", () => {
    const text = JSON.stringify({
      openbindings: "0.2.0",
      operations: {},
      "x-vendor": "v1",
    });
    const iface = parseDocument(text);
    const patched = { ...iface, name: "Patched" };
    expect((patched as Record<string, unknown>)["x-vendor"]).toBe("v1");
    expect(patched.name).toBe("Patched");
  });
});

import { describe, it, expect } from "vitest";
import {
  parseFormatToken,
  isFormatToken,
  normalizeFormatToken,
  formatTokenToString,
  isOpenBindingsToken,
  parseRange,
  matchesRange,
} from "./format-token.js";

describe("parseFormatToken", () => {
  it("parses a valid token", () => {
    const t = parseFormatToken("OpenAPI@3.1");
    expect(t.name).toBe("openapi");
    expect(t.version).toBe("3.1");
  });

  it("throws on empty string", () => {
    expect(() => parseFormatToken("")).toThrow("empty");
  });

  it("throws on invalid format (no @)", () => {
    expect(() => parseFormatToken("openapi")).toThrow("invalid");
  });

  it("preserves version case", () => {
    const t = parseFormatToken("grpc@Proto3");
    expect(t.version).toBe("Proto3");
    expect(t.name).toBe("grpc");
  });
});

describe("isFormatToken", () => {
  it("returns true for valid tokens", () => {
    expect(isFormatToken("openapi@3.1")).toBe(true);
  });

  it("returns false for invalid tokens", () => {
    expect(isFormatToken("")).toBe(false);
    expect(isFormatToken("nope")).toBe(false);
  });
});

describe("normalizeFormatToken", () => {
  it("normalizes name to lowercase", () => {
    expect(normalizeFormatToken("OpenAPI@3.1")).toBe("openapi@3.1");
  });
});

describe("formatTokenToString", () => {
  it("joins name@version", () => {
    expect(formatTokenToString({ name: "grpc", version: "1.0" })).toBe("grpc@1.0");
  });

  it("returns empty for missing parts", () => {
    expect(formatTokenToString({ name: "", version: "1.0" })).toBe("");
    expect(formatTokenToString({ name: "x", version: "" })).toBe("");
  });
});

describe("isOpenBindingsToken", () => {
  it("matches openbindings name", () => {
    expect(isOpenBindingsToken({ name: "openbindings", version: "0.1.0" })).toBe(true);
    expect(isOpenBindingsToken({ name: "openapi", version: "3.1" })).toBe(false);
  });
});

describe("matchesRange", () => {
  const check = (rangeToken: string, sourceToken: string) =>
    matchesRange(parseRange(rangeToken), sourceToken);

  it("caret range matches higher minor", () => {
    expect(check("openapi@^3.0.0", "openapi@3.1")).toBe(true);
  });
  it("caret range matches equal version", () => {
    expect(check("openapi@^3.0.0", "openapi@3.0")).toBe(true);
  });
  it("caret range matches equal full version", () => {
    expect(check("openapi@^3.0.0", "openapi@3.0.0")).toBe(true);
  });
  it("caret range matches high minor.patch", () => {
    expect(check("openapi@^3.0.0", "openapi@3.9.9")).toBe(true);
  });
  it("caret range rejects next major", () => {
    expect(check("openapi@^3.0.0", "openapi@4.0")).toBe(false);
  });
  it("caret range rejects lower major", () => {
    expect(check("openapi@^3.0.0", "openapi@2.0")).toBe(false);
  });
  it("caret range rejects lower minor", () => {
    expect(check("openapi@^3.2.0", "openapi@3.1")).toBe(false);
  });
  it("exact match for date versions", () => {
    expect(check("mcp@2025-11-25", "mcp@2025-11-25")).toBe(true);
  });
  it("exact mismatch for date versions", () => {
    expect(check("mcp@2025-11-25", "mcp@2025-12-01")).toBe(false);
  });
  it("versionless matches versionless", () => {
    expect(check("grpc", "grpc")).toBe(true);
  });
  it("versionless does not match versioned", () => {
    expect(check("grpc", "grpc@1.0")).toBe(false);
  });
  it("versioned does not match versionless", () => {
    expect(check("grpc@1.0", "grpc")).toBe(false);
  });
  it("exact normalizes trailing .0", () => {
    expect(check("openapi@3.1.0", "openapi@3.1")).toBe(true);
  });
  it("exact normalizes trailing .0 (reverse)", () => {
    expect(check("openapi@3.1", "openapi@3.1.0")).toBe(true);
  });
  it("case insensitive matching", () => {
    expect(check("OpenAPI@^3.0.0", "openapi@3.1")).toBe(true);
  });
});

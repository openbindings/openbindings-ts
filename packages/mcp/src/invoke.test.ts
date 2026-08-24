import { describe, it, expect } from "vitest";
import { parseSelector, parseContent } from "./invoke.js";

describe("parseSelector", () => {
  it("parses tool selector", () => {
    const result = parseSelector("tools/get_weather");
    expect(result).toEqual({ entityType: "tools", name: "get_weather" });
  });

  it("parses resource selector with URI", () => {
    const result = parseSelector("resources/file:///data.csv");
    expect(result).toEqual({ entityType: "resources", name: "file:///data.csv" });
  });

  it("parses resource template selector under its own entity (R5)", () => {
    const result = parseSelector("resourceTemplates/users/{id}");
    expect(result).toEqual({ entityType: "resourceTemplates", name: "users/{id}" });
  });

  it("parses prompt selector", () => {
    const result = parseSelector("prompts/summarize");
    expect(result).toEqual({ entityType: "prompts", name: "summarize" });
  });

  it("rejects empty selector", () => {
    expect(() => parseSelector("")).toThrow();
  });

  it("rejects selector without slash", () => {
    expect(() => parseSelector("toolsgetweather")).toThrow();
  });

  it("rejects unknown entity type", () => {
    expect(() => parseSelector("unknown/foo")).toThrow(/invalid entity type/);
  });

  it("rejects trailing slash", () => {
    expect(() => parseSelector("tools/")).toThrow();
  });
});

describe("parseContent", () => {
  // De-sniff ruling: decode is decided by declared/structural rules, never
  // by tasting the payload. A single text block whose text happens to
  // parse as JSON must still come back as the verbatim string -- a latent
  // "single text content: try JSON parse" branch used to sniff this case
  // (reachable only for a malformed non-string "text" field in practice,
  // since runTool's fast path intercepts every valid single-text-string
  // result before parseContent is ever called); it's deleted, and this
  // pins the invariant directly on the function.
  it("returns a single text block verbatim, never JSON-parsed, even when it looks like JSON", () => {
    const result = parseContent([{ type: "text", text: '{"tempC":20}' }]);
    expect(result).toBe('{"tempC":20}');
  });

  it("passes multiple text blocks through as the content array, verbatim (MCP-P-05), never a joined string", () => {
    // §9.3: a single text block is the string above; ANY OTHER content shape
    // — two or more text blocks included — passes through as the content
    // array, verbatim in MCP's block shapes, never a "\n"-joined string.
    const content = [
      { type: "text", text: "prefix" },
      { type: "text", text: '{"a":1}' },
    ];
    expect(parseContent(content)).toBe(content);
  });

  it("passes mixed content types through as an array", () => {
    const content = [{ type: "text", text: "hi" }, { type: "image", mimeType: "image/png", data: "..." }];
    expect(parseContent(content)).toBe(content);
  });

  it("passes an empty array through unchanged", () => {
    expect(parseContent([])).toEqual([]);
  });
});

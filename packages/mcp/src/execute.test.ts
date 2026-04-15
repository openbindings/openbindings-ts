import { describe, it, expect } from "vitest";
import { parseRef } from "./execute.js";

describe("parseRef", () => {
  it("parses tool ref", () => {
    const result = parseRef("tools/get_weather");
    expect(result).toEqual({ entityType: "tools", name: "get_weather" });
  });

  it("parses resource ref with URI", () => {
    const result = parseRef("resources/file:///data.csv");
    expect(result).toEqual({ entityType: "resources", name: "file:///data.csv" });
  });

  it("parses resource template ref", () => {
    const result = parseRef("resources/users/{id}");
    expect(result).toEqual({ entityType: "resources", name: "users/{id}" });
  });

  it("parses prompt ref", () => {
    const result = parseRef("prompts/summarize");
    expect(result).toEqual({ entityType: "prompts", name: "summarize" });
  });

  it("rejects empty ref", () => {
    expect(() => parseRef("")).toThrow();
  });

  it("rejects ref without slash", () => {
    expect(() => parseRef("toolsgetweather")).toThrow();
  });

  it("rejects unknown entity type", () => {
    expect(() => parseRef("unknown/foo")).toThrow(/invalid entity type/);
  });

  it("rejects trailing slash", () => {
    expect(() => parseRef("tools/")).toThrow();
  });
});

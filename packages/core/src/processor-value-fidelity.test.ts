import { describe, expect, it } from "vitest";
import { parseJSON } from "@openbindings/json";
import { checkAssertions } from "./processor-scenarios.js";

describe("official SDK corpus assertion value handling", () => {
  it("does not confuse a numeric carrier with application data shaped like it", () => {
    expect(() => checkAssertions({ x: parseJSON("9007199254740993") }, [
      { path: "/x", equals: { rawJSON: "9007199254740993" } },
    ])).toThrow();
    expect(() => checkAssertions({ x: parseJSON("9007199254740993") }, [
      { path: "/x/rawJSON", absent: true },
    ])).not.toThrow();
  });
  it("compares numeric values, not retained token spelling", () => {
    expect(() => checkAssertions({ x: parseJSON("9007199254740993") }, [
      { path: "/x", equals: parseJSON("9007199254740993.0") },
    ])).not.toThrow();
  });
  it("does not round semantic JSON decoded from a query parameter", () => {
    expect(() => checkAssertions({ x: "?payload=9007199254740993" }, [
      { path: "/x", semanticEquals: { as: "query-json-parameter", name: "payload", names: ["payload"], value: parseJSON("9007199254740993") } },
    ])).not.toThrow();
  });
});

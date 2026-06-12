import { describe, expect, it } from "vitest";
import {
  validateGraph,
  allowedNodeFields,
  requiredNodeFields,
  SPEC_NODE_FIELDS,
} from "./validate.js";
import type { Graph } from "./types.js";

function graph(nodes: Record<string, unknown>, edges: { from: string; to: string }[]): Graph {
  return {
    "openbindings.operation-graph": "0.2.0",
    nodes,
    edges,
  } as Graph;
}

describe("validateGraph field types", () => {
  it("accepts a transform node with a plain string expression", () => {
    const g = graph(
      {
        in: { type: "input" },
        t: { type: "transform", transform: "{ \"name\": firstName }" },
        out: { type: "output" },
      },
      [
        { from: "in", to: "t" },
        { from: "t", to: "out" },
      ],
    );
    expect(validateGraph(g)).toEqual([]);
  });

  it("rejects the legacy object transform shape", () => {
    const g = graph(
      {
        in: { type: "input" },
        t: { type: "transform", transform: { type: "jsonata", expression: "customer" } },
        out: { type: "output" },
      },
      [
        { from: "in", to: "t" },
        { from: "t", to: "out" },
      ],
    );
    const issues = validateGraph(g);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('field "transform" must be a string');
    expect(issues[0].nodeKeys).toEqual(["t"]);
  });

  it("rejects wrong types for numeric, boolean, and schema fields", () => {
    const g = graph(
      {
        in: { type: "input" },
        f: { type: "filter", schema: "not-an-object" },
        b: { type: "buffer", limit: "5" },
        x: { type: "exit", error: "yes" },
        out: { type: "output" },
      },
      [
        { from: "in", to: "f" },
        { from: "f", to: "b" },
        { from: "b", to: "out" },
        { from: "f", to: "x" },
      ],
    );
    const messages = validateGraph(g).map((i) => i.message);
    expect(messages).toContainEqual(expect.stringContaining('"schema" must be a object'));
    expect(messages).toContainEqual(expect.stringContaining('"limit" must be a number'));
    expect(messages).toContainEqual(expect.stringContaining('"error" must be a boolean'));
  });
});

describe("node field rules exports", () => {
  it("exposes per-type whitelists including required fields", () => {
    expect(allowedNodeFields("each")).toEqual(
      new Set(["operation", "maxIterations", "timeout", "onError"]),
    );
    expect(requiredNodeFields("each")).toEqual(["operation"]);
    expect(allowedNodeFields("combine")).toEqual(new Set(["onError"]));
    expect(requiredNodeFields("input")).toEqual([]);
  });

  it("returns undefined for unknown types", () => {
    expect(allowedNodeFields("nope")).toBeUndefined();
    expect(requiredNodeFields("nope")).toBeUndefined();
  });

  it("whitelists only draw from the spec field universe", () => {
    const universe = new Set(SPEC_NODE_FIELDS);
    for (const type of ["input", "output", "operation", "each", "buffer", "filter", "transform", "map", "combine", "exit"]) {
      for (const f of allowedNodeFields(type) ?? []) {
        expect(universe.has(f)).toBe(true);
      }
    }
  });
});

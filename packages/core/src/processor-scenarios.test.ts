import { describe, expect, it } from "vitest";
import {
  matchProcessorObservation,
  type ProcessorScenario,
} from "./processor-scenarios.js";

describe("processor scenario matcher", () => {
  it("matches unordered alternatives while preserving absence", () => {
    const scenario: ProcessorScenario = {
      id: "TEST-PS-01",
      rules: ["TEST-P-01"],
      section: "1",
      description: "test",
      given: { source: {}, binding: {}, invocation: { inputPresent: false } },
      expected: [
        {
          disposition: "complete",
          phase: "completion",
          assertions: [{ path: "/choice", equals: "a" }],
        },
        {
          disposition: "complete",
          phase: "completion",
          assertions: [
            { path: "/choice", equals: "b" },
            { path: "/missing", absent: true },
          ],
        },
      ],
    };
    expect(
      matchProcessorObservation(scenario, {
        disposition: "complete",
        phase: "completion",
        data: { choice: "b" },
      }),
    ).toEqual({ alternative: 1 });
  });

  it("supports set and contains assertions", () => {
    const scenario: ProcessorScenario = {
      id: "TEST-PS-02",
      rules: ["TEST-P-02"],
      section: "1",
      description: "test",
      given: { source: {}, binding: {}, invocation: { inputPresent: false } },
      expected: [
        {
          disposition: "complete",
          phase: "completion",
          assertions: [
            { path: "/set", setEquals: ["a", "b"] },
            { path: "/text", contains: "needle" },
          ],
        },
      ],
    };
    expect(() =>
      matchProcessorObservation(scenario, {
        disposition: "complete",
        phase: "completion",
        data: { set: ["b", "a"], text: "a needle here" },
      }),
    ).not.toThrow();
  });
});

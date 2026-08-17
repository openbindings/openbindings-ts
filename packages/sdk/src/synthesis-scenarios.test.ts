import { describe, expect, it } from "vitest";
import type { ProcessorAssertion, SynthesisScenario, SynthesizeResult } from "./index.js";
import {
  SYNTHESIS_SCENARIO_FORMAT,
  parseSynthesisScenarioFile,
  verifySynthesisScenario,
} from "./synthesis-scenarios.js";

const refused: SynthesisScenario = {
  id: "OAPI-SS-99",
  description: "runner refusal seam",
  source: { bindingSpec: "openbindings.openapi@1" },
  expected: {
    outcome: "refused",
    rules: ["OAPI-P-03"],
  },
};

describe("portable synthesis scenario outcomes", () => {
  it("accepts a loud failure without comparing language-specific error shape", async () => {
    await expect(verifySynthesisScenario(refused, async () => {
      throw new TypeError("incidental implementation prose");
    })).resolves.toBeUndefined();
  });

  it("does not mistake successful synthesis for the required refusal", async () => {
    await expect(verifySynthesisScenario(
      refused,
      async () => ({}) as SynthesizeResult,
    )).rejects.toThrow("expected whole-source refusal but synthesis succeeded");
  });

  it("propagates synthesis failure when the corpus requires success", async () => {
    const synthesized: SynthesisScenario = {
      ...refused,
      expected: {
        outcome: "synthesized",
        operations: [],
        bindings: [],
        coverage: {
          exhaustive: true,
          fullyRepresented: true,
          entries: [],
        },
      },
    };
    await expect(verifySynthesisScenario(synthesized, async () => {
      throw new Error("unexpected failure");
    })).rejects.toThrow("unexpected failure");
  });
});

describe("portable synthesis corpus revision", () => {
  const wellFormed = {
    format: SYNTHESIS_SCENARIO_FORMAT,
    bindingSpec: "openbindings.openapi@1",
    family: "openapi",
    description: "one scenario",
    scenarios: [refused],
  };

  it("accepts the revision this runner implements", () => {
    expect(parseSynthesisScenarioFile(wellFormed, "openapi").scenarios).toHaveLength(1);
  });

  it("refuses a revision it does not implement rather than running it silently", () => {
    for (const format of [
      "openbindings.binding-spec-synthesis-scenarios@2",
      "openbindings.binding-spec-synthesis-scenarios@4",
      undefined,
    ]) {
      expect(() => parseSynthesisScenarioFile({ ...wellFormed, format }, "openapi"))
        .toThrow("unsupported synthesis scenario format");
    }
  });

  it("refuses a file whose family does not match the one requested", () => {
    expect(() => parseSynthesisScenarioFile(wellFormed, "usage"))
      .toThrow("malformed synthesis family file");
  });
});

describe("portable synthesis scenario assertions", () => {
  const withAssertion = (assertions: ProcessorAssertion[]): SynthesisScenario => ({
    id: "OAPI-SS-98",
    description: "emitted-document assertion seam",
    source: { bindingSpec: "openbindings.openapi@1" },
    expected: {
      outcome: "synthesized",
      operations: ["probe"],
      bindings: [],
      assertions,
      coverage: { exhaustive: true, fullyRepresented: true, entries: [] },
    },
  });

  const result = {
    interface: {
      openbindings: "0.2.0",
      operations: { probe: { input: { properties: { issued: { example: "2020-01-01T12:00:00Z" } } } } },
    },
    coverage: { exhaustive: true, fullyRepresented: true, entries: [] },
  } as unknown as SynthesizeResult;

  it("passes an assertion the emitted document satisfies", async () => {
    await expect(verifySynthesisScenario(
      withAssertion([
        { path: "/operations/probe/input/properties/issued/example", equals: "2020-01-01T12:00:00Z" },
      ]),
      async () => result,
    )).resolves.toBeUndefined();
  });

  it("fails an assertion the emitted document violates, naming the pointer", async () => {
    await expect(verifySynthesisScenario(
      withAssertion([
        { path: "/operations/probe/input/properties/issued/example", equals: {} },
      ]),
      async () => result,
    )).rejects.toThrow("emitted-document assertion failed");
  });
});

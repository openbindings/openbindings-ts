import { describe, expect, it } from "vitest";
import type { ProcessorAssertion } from "@openbindings/core";
import type { SynthesisScenario, SynthesizeResult } from "./index.js";
import {
  SYNTHESIS_SCENARIO_FORMAT,
  fixedSynthesizer,
  parseSynthesisScenarioFile,
  verifySynthesisScenario,
} from "./synthesis-scenarios.js";

// Every fixture source carries `content`, because the scenario schema adopts
// interface-synthesizer 0.2's `anyOf: [location, content]`: a fixture the
// corpus schema would reject has no business standing in for one here.
const refused: SynthesisScenario = {
  id: "OAPI-SS-99",
  description: "runner refusal seam",
  source: { bindingSpec: "openbindings.openapi@1", content: {} },
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
      "openbindings.binding-spec-synthesis-scenarios@3",
      "openbindings.binding-spec-synthesis-scenarios@5",
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

  it("refuses a file that is not an object at all", () => {
    for (const raw of [null, [], "openapi", 7]) {
      expect(() => parseSynthesisScenarioFile(raw, "openapi"))
        .toThrow("malformed synthesis family file");
    }
  });
});

describe("companion-resource guard for self-contained families", () => {
  const synthesizer = { marker: "the family's own synthesizer" };
  const factory = fixedSynthesizer(synthesizer);

  it("passes a scenario declaring no companion resources straight through", () => {
    expect(factory(refused)).toBe(synthesizer);
    expect(factory({ ...refused, resources: {} })).toBe(synthesizer);
  });

  it("refuses a scenario declaring companion resources, naming the scenario", () => {
    expect(() => factory({
      ...refused,
      resources: { "https://companion.example/library.yaml": {} },
    })).toThrow("OAPI-SS-99: declares companion resources, which this family's runner does not serve");
  });
});

describe("portable synthesis scenario assertions", () => {
  const withAssertion = (assertions: ProcessorAssertion[]): SynthesisScenario => ({
    id: "OAPI-SS-98",
    description: "emitted-document assertion seam",
    source: { bindingSpec: "openbindings.openapi@1", content: {} },
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

  it("keeps assertions out of the compared identity surface", async () => {
    // The scenario carries an assertion AND declares the identity surface.
    // Only operations, bindings and coverage are diffed, so an assertion list
    // never leaks into the comparison that decides scenario identity.
    await expect(verifySynthesisScenario(
      withAssertion([{ path: "/openbindings", equals: "0.2.0" }]),
      async () => result,
    )).resolves.toBeUndefined();
  });
});

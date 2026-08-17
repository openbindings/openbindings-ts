import { describe, expect, it } from "vitest";
import type { SynthesisScenario, SynthesizeResult } from "./index.js";
import { verifySynthesisScenario } from "./synthesis-scenarios.js";

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

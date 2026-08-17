import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fixedSynthesizer,
  parseSynthesisScenarioFile,
  verifySynthesisScenario,
} from "@openbindings/sdk";
import { describe, expect, it } from "vitest";
import { ConnectSynthesizer } from "./index.js";

const root = process.env.OB_SPEC_CORPUS
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
const corpus = parseSynthesisScenarioFile(
  JSON.parse(readFileSync(resolve(root, "binding-specs/synthesis/connect.json"), "utf8")),
  "connect",
);

// This family's corpus sources are self-contained, so the factory is fixed: a
// scenario declaring companion documents is refused loudly rather than executed
// against a resolver that would never see them. It is called OUTSIDE
// verifySynthesisScenario, exactly where openbindings-go's Verify calls its own
// factory, so the refusal can never be absorbed as a satisfied "refused"
// outcome.
const synthesizerFor = fixedSynthesizer(new ConnectSynthesizer());

describe("portable Connect synthesis scenarios", () => {
  for (const scenario of corpus.scenarios) {
    it(scenario.id, async () => {
      const synthesizer = synthesizerFor(scenario);
      await verifySynthesisScenario(scenario, () => synthesizer.synthesizeInterfaceWithCoverage({
        sources: [scenario.source],
      }));
    });
  }

  it("refuses a scenario declaring companion resources this runner does not serve", () => {
    expect(() => synthesizerFor({
      id: "PROBE-SS-99",
      description: "companion-resource guard",
      source: { bindingSpec: corpus.bindingSpec, content: {} },
      resources: { "https://companion.example/library.yaml": {} },
      expected: { outcome: "refused", rules: [] },
    })).toThrow("declares companion resources");
  });
});

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  verifySynthesisScenario,
  type SynthesisScenarioFile,
} from "@openbindings/sdk";
import { describe, it } from "vitest";
import { UsageSynthesizer } from "./index.js";

const root = process.env.OB_SPEC_CORPUS
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
const corpus = JSON.parse(
  readFileSync(resolve(root, "binding-specs/synthesis/usage.json"), "utf8"),
) as SynthesisScenarioFile;

describe("portable Usage synthesis scenarios", () => {
  for (const scenario of corpus.scenarios) {
    it(scenario.id, async () => {
      await verifySynthesisScenario(scenario, () => new UsageSynthesizer().synthesizeInterfaceWithCoverage({
        sources: [scenario.source],
      }));
    });
  }
});

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  matchSynthesisScenario,
  type SynthesisScenarioFile,
} from "@openbindings/sdk";
import { describe, it } from "vitest";
import { ConnectSynthesizer } from "./index.js";

const root = process.env.OB_SPEC_CORPUS
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
const corpus = JSON.parse(
  readFileSync(resolve(root, "binding-specs/synthesis/connect.json"), "utf8"),
) as SynthesisScenarioFile;

describe("portable Connect synthesis scenarios", () => {
  for (const scenario of corpus.scenarios) {
    it(scenario.id, async () => {
      const result = await new ConnectSynthesizer().synthesizeInterfaceWithCoverage({
        sources: [scenario.source],
      });
      matchSynthesisScenario(scenario, result);
    });
  }
});

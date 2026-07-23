import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  matchSynthesisScenario,
  type SynthesisScenarioFile,
} from "@openbindings/sdk";
import { describe, it } from "vitest";
import { AsyncAPISynthesizer } from "./invoker.js";

const root = process.env.OB_SPEC_CORPUS
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
const corpus = JSON.parse(
  readFileSync(resolve(root, "binding-specs/synthesis/asyncapi.json"), "utf8"),
) as SynthesisScenarioFile;

describe("portable AsyncAPI synthesis scenarios", () => {
  for (const scenario of corpus.scenarios) {
    it(scenario.id, async () => {
      const result = await new AsyncAPISynthesizer().synthesizeInterfaceWithCoverage({
        sources: [scenario.source],
      });
      matchSynthesisScenario(scenario, result);
    });
  }
});

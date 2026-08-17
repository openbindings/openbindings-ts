import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  verifySynthesisScenario,
  type SynthesisScenarioFile,
} from "@openbindings/sdk";
import { describe, it } from "vitest";
import { OpenAPISynthesizer } from "./invoker.js";

const root = process.env.OB_SPEC_CORPUS
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
const corpus = JSON.parse(
  readFileSync(resolve(root, "binding-specs/synthesis/openapi.json"), "utf8"),
) as SynthesisScenarioFile;

describe("portable OpenAPI synthesis scenarios", () => {
  for (const scenario of corpus.scenarios) {
    it(scenario.id, async () => {
      await verifySynthesisScenario(scenario, () => new OpenAPISynthesizer().synthesizeInterfaceWithCoverage({
        sources: [scenario.source],
      }));
    });
  }
});

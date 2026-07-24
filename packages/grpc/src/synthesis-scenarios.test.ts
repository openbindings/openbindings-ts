import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  verifySynthesisScenario,
  type SynthesisScenarioFile,
} from "@openbindings/sdk";
import { describe, it } from "vitest";
import { GrpcSynthesizer } from "./index.js";

const root = process.env.OB_SPEC_CORPUS
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
const corpus = JSON.parse(
  readFileSync(resolve(root, "binding-specs/synthesis/grpc.json"), "utf8"),
) as SynthesisScenarioFile;

describe("portable gRPC synthesis scenarios", () => {
  for (const scenario of corpus.scenarios) {
    it(scenario.id, async () => {
      await verifySynthesisScenario(scenario, () => new GrpcSynthesizer().synthesizeInterfaceWithCoverage({
        sources: [scenario.source],
      }));
    });
  }
});

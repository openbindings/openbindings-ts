import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseSynthesisScenarioFile,
  verifySynthesisScenario,
} from "@openbindings/sdk";
import { describe, it } from "vitest";
import { MCPSynthesizer } from "./invoker.js";

const root = process.env.OB_SPEC_CORPUS
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
const corpus = parseSynthesisScenarioFile(
  JSON.parse(readFileSync(resolve(root, "binding-specs/synthesis/mcp.json"), "utf8")),
  "mcp",
);

describe("portable MCP synthesis scenarios", () => {
  for (const scenario of corpus.scenarios) {
    it(scenario.id, async () => {
      await verifySynthesisScenario(scenario, () => new MCPSynthesizer().synthesizeInterfaceWithCoverage({
        sources: [scenario.source],
      }));
    });
  }
});

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseSynthesisScenarioFile,
  verifySynthesisScenario,
  type SynthesisScenario,
} from "@openbindings/sdk";
import { describe, it } from "vitest";
import { OpenAPISynthesizer } from "./invoker.js";

const root = process.env.OB_SPEC_CORPUS
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
const corpus = parseSynthesisScenarioFile(
  JSON.parse(readFileSync(resolve(root, "binding-specs/synthesis/openapi.json"), "utf8")),
  "openapi",
);

/**
 * Serves a scenario's declared companion documents and nothing else. Every
 * address a multi-document corpus scenario reaches must be answerable from its
 * own closed resource map, so the suite never touches the network; an unlisted
 * address is a 404 rather than a live retrieval.
 */
function synthesisResourceFetch(resources: Record<string, unknown>): typeof globalThis.fetch {
  return async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const resource = resources[url];
    if (resource === undefined) {
      return new Response("no such corpus resource", { status: 404 });
    }
    return new Response(
      typeof resource === "string" ? resource : JSON.stringify(resource),
      { status: 200 },
    );
  };
}

function synthesizerFor(scenario: SynthesisScenario): OpenAPISynthesizer {
  const resources = scenario.resources;
  if (resources === undefined || Object.keys(resources).length === 0) {
    return new OpenAPISynthesizer();
  }
  return new OpenAPISynthesizer({ fetch: synthesisResourceFetch(resources) });
}

describe("portable OpenAPI synthesis scenarios", () => {
  for (const scenario of corpus.scenarios) {
    it(scenario.id, async () => {
      await verifySynthesisScenario(scenario, () => synthesizerFor(scenario)
        .synthesizeInterfaceWithCoverage({ sources: [scenario.source] }));
    });
  }
});

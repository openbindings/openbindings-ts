import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseSynthesisScenarioFile,
  verifySynthesisScenario,
  type SynthesisScenario,
} from "@openbindings/sdk";
import { describe, expect, it } from "vitest";
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

/**
 * This family's factory. Unlike the six self-contained families it does serve
 * companion documents, through the `fetch` seam `OpenAPISynthesizer` already
 * takes.
 */
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
      const synthesizer = synthesizerFor(scenario);
      await verifySynthesisScenario(scenario, () => synthesizer.synthesizeInterfaceWithCoverage({
        sources: [scenario.source],
      }));
    });
  }

  it("serves only the addresses a scenario declares", async () => {
    const serve = synthesisResourceFetch({
      "https://companion.example/library.yaml": "openapi: 3.1.2\n",
    });
    expect((await serve("https://companion.example/library.yaml")).status).toBe(200);
    expect((await serve("https://companion.example/elsewhere.yaml")).status).toBe(404);
  });
});

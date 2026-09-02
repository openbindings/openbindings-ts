import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSynthesisScenarioFile, verifySynthesisScenario, type SynthesisScenario } from "@openbindings/synthesize";
import { afterAll, describe, expect, it } from "vitest";
import { OpenAPISynthesizer } from "./invoker.js";

if (process.env.OB_CORPUS_REQUIRED === "1" && !process.env.OB_SPEC_CORPUS) {
  throw new Error("OB_CORPUS_REQUIRED=1 requires OB_SPEC_CORPUS");
}
const root = process.env.OB_SPEC_CORPUS
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
const corpora = ["openapi-2.0", "openapi-3.0", "openapi-3.1", "openapi-3.2"].map((family) =>
  parseSynthesisScenarioFile(
    JSON.parse(readFileSync(resolve(root, "binding-specs/synthesis", `${family}.json`), "utf8")),
    family,
  ));
const scenarios = corpora.flatMap((corpus) => corpus.scenarios);

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
  let executed = 0;

  for (const scenario of scenarios) {
    it(scenario.id, async () => {
      const synthesizer = synthesizerFor(scenario);
      await verifySynthesisScenario(scenario, () => synthesizer.synthesizeInterfaceWithCoverage({
        sources: [scenario.source],
      }));
      executed += 1;
    });
  }

  afterAll(() => {
    expect(corpora.map((corpus) => corpus.scenarios.length)).toEqual([11, 16, 33, 10]);
    expect(executed).toBe(70);
  });

  it("serves only the addresses a scenario declares", async () => {
    const serve = synthesisResourceFetch({
      "https://companion.example/library.yaml": "openapi: 3.1.2\n",
    });
    expect((await serve("https://companion.example/library.yaml")).status).toBe(200);
    expect((await serve("https://companion.example/elsewhere.yaml")).status).toBe(404);
  });
});

// Binding-specification conformance corpus adapter. Embedded artifacts run
// through UsageSynthesizer's parser and exact command inventory. Locations
// run through its output-location validator while an embedded descriptor
// prevents document or process I/O. Location-only refs are grammar-checked
// because live artifact resolution is intentionally unverifiable offline.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BINDING_SPEC, UsageSynthesizer } from "./index.js";

interface CorpusFixture {
  rule: string;
  bindingSpec: string;
  tests: Array<{ description: string; document: CorpusDocument; valid: boolean }>;
}

interface CorpusDocument {
  sources?: Record<string, CorpusSource>;
  bindings?: Record<string, CorpusBinding>;
}

interface CorpusSource {
  bindingSpec?: string;
  location?: string;
  content?: unknown;
}

interface CorpusBinding {
  source?: string;
  selector?: string;
}

const validationDescriptor = "name \"fixture\"\nbin \"fixture\"\ncmd \"status\"\n";
const root = process.env.OB_SPEC_CORPUS
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
const dir = join(root, "binding-specs/usage");
const available = existsSync(dir);

if (!available && process.env.OB_CORPUS_REQUIRED) {
  throw new Error("Usage binding-spec corpus is required but unavailable; set OB_SPEC_CORPUS");
}

async function judge(document: CorpusDocument): Promise<string | undefined> {
  const synthesizer = new UsageSynthesizer();
  try {
    for (const [sourceName, source] of Object.entries(document.sources ?? {})) {
      if (source.bindingSpec !== BINDING_SPEC) continue;

      let availableSelectors: Set<string> | undefined;
      if (Object.hasOwn(source, "content")) {
        const inspection = await synthesizer.inspectSource({
          bindingSpec: BINDING_SPEC,
          content: source.content,
        });
        availableSelectors = new Set(inspection.targets.map((target) => target.selector));
      }

      if (Object.hasOwn(source, "location")) {
        await synthesizer.synthesizeInterface({
          sources: [{
            bindingSpec: BINDING_SPEC,
            content: validationDescriptor,
            outputLocation: source.location,
          }],
        });
      }

      for (const binding of Object.values(document.bindings ?? {})) {
        if (binding.source !== sourceName || !Object.hasOwn(binding, "selector")) continue;
        const selector = binding.selector ?? "";
        if (selector === "" || selector.split(" ").some((segment) => segment === "")) {
          return `usage selector ${JSON.stringify(selector)} is not a non-empty single-space-separated command path`;
        }
        if (availableSelectors && !availableSelectors.has(selector)) {
          return `usage selector ${JSON.stringify(selector)} does not resolve uniquely in the embedded descriptor`;
        }
      }
    }
    return undefined;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe.skipIf(!available)("binding-spec conformance corpus (usage)", () => {
  if (!available) return;
  const files = readdirSync(dir).filter((file) => file.endsWith(".json"));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(dir, file), "utf8")) as CorpusFixture;
    expect(fixture.bindingSpec).toBe(BINDING_SPEC);
    describe(fixture.rule, () => {
      for (const test of fixture.tests) {
        it(test.description, async () => {
          const refusal = await judge(test.document);
          if (test.valid && refusal !== undefined) {
            expect.fail(`valid fixture refused: ${refusal}`);
          }
          if (!test.valid && refusal === undefined) {
            expect.fail("invalid fixture accepted");
          }
        });
      }
    });
  }
});

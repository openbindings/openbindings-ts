import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BINDING_SPEC } from "./constants.js";
import { parseIntrospectionContent, parseSelector, resolveField } from "./invoke.js";
import { validateHTTPLocation } from "./configuration.js";

interface CorpusFixture {
  rule: string;
  bindingSpec: string;
  tests: Array<{ description: string; document: CorpusDocument; valid: boolean }>;
}
interface CorpusDocument {
  sources?: Record<string, { bindingSpec?: string; location?: string; content?: unknown }>;
  bindings?: Record<string, { source?: string; selector?: string }>;
}

const root = process.env.OB_SPEC_CORPUS
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
const dir = join(root, "binding-specs/graphql");
const available = existsSync(dir);
if (!available && process.env.OB_CORPUS_REQUIRED) {
  throw new Error("GraphQL binding-spec corpus is required but unavailable; set OB_SPEC_CORPUS");
}

function judge(document: CorpusDocument): string | undefined {
  try {
    for (const [sourceName, source] of Object.entries(document.sources ?? {})) {
      if (source.bindingSpec !== BINDING_SPEC) continue;
      validateHTTPLocation(source.location);
      const schema = source.content !== undefined
        ? parseIntrospectionContent(source.content)
        : undefined;
      for (const binding of Object.values(document.bindings ?? {})) {
        if (binding.source !== sourceName) continue;
        const { rootType, fieldName } = parseSelector(binding.selector ?? "");
        if (rootType === "subscription") throw new Error(`subscription refs are outside ${BINDING_SPEC}`);
        if (schema) resolveField(schema, rootType, fieldName);
      }
    }
    return undefined;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe.skipIf(!available)("binding-spec conformance corpus (graphql)", () => {
  if (!available) return;
  const files = readdirSync(dir).filter((file) => file.endsWith(".json"));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(dir, file), "utf8")) as CorpusFixture;
    expect(fixture.bindingSpec).toBe(BINDING_SPEC);
    describe(fixture.rule, () => {
      for (const test of fixture.tests) {
        it(test.description, () => {
          const refusal = judge(test.document);
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

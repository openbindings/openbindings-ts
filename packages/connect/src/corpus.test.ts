// Binding-specification conformance corpus adapter. Every fixture is routed
// through ConnectInvoker's pre-dispatch ref, base-URL, and schema lanes. A
// sentinel fetch proves that valid family material reached dispatch without
// performing network I/O; any earlier terminal error is a bind-time refusal.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BINDING_SPEC, ConnectInvoker } from "./index.js";

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
  operation?: string;
  source?: string;
  ref?: string;
}

const accepted = "OPENBINDINGS_CORPUS_ACCEPTED";
const root = process.env.OB_SPEC_CORPUS
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
const dir = join(root, "binding-specs/connect");
const available = existsSync(dir);

if (!available && process.env.OB_CORPUS_REQUIRED) {
  throw new Error("Connect binding-spec corpus is required but unavailable; set OB_SPEC_CORPUS");
}

async function judge(document: CorpusDocument): Promise<string | undefined> {
  for (const [sourceName, source] of Object.entries(document.sources ?? {})) {
    if (source.bindingSpec !== BINDING_SPEC) continue;
    for (const binding of Object.values(document.bindings ?? {})) {
      if (binding.source !== sourceName) continue;
      let dispatched = false;
      const call = new ConnectInvoker({ fullDuplex: true }).invokeBinding({
        source: {
          bindingSpec: BINDING_SPEC,
          ...(Object.hasOwn(source, "location") ? { location: source.location } : {}),
          ...(Object.hasOwn(source, "content") ? { content: source.content } : {}),
        },
        ref: binding.ref ?? "",
        binding: {
          operation: binding.operation ?? "fixture",
          source: sourceName,
          ...(Object.hasOwn(binding, "ref") ? { ref: binding.ref } : {}),
        },
        fetch: async () => {
          dispatched = true;
          throw new Error(accepted);
        },
      });
      await call.write({}).catch(() => {});
      await call.close().catch(() => {});
      try {
        for await (const _ of call.outputs) {
          // Valid fixtures never receive a response: the sentinel fetch
          // terminates as soon as all family-scoped material is accepted.
        }
        return "Connect invocation completed without reaching the sentinel fetch";
      } catch (error: unknown) {
        if (!dispatched) return String(error);
      }
    }
  }
  return undefined;
}

describe.skipIf(!available)("binding-spec conformance corpus (connect)", () => {
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

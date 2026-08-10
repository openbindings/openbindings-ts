// Binding-specification conformance corpus adapter: runs the spec
// repository's binding-specs/openapi fixtures (OAPI-D-01..03) through this
// package's own offline lanes — content load, location grammar, and ref
// grammar/resolution — under the subcorpus README's verdict semantics:
// valid:false means a conformant openbindings.openapi@2 processor refuses
// the document's family-scoped material at or before bind time, decidable
// offline with no network and no live source. Positive location-only
// fixtures are judged by grammar alone (never dereferenced), so the run
// performs no I/O beyond reading the fixtures. Mirrors the Go SDK's
// formats/openapi/corpus_test.go.
//
// The corpus root is located via OB_SPEC_CORPUS (the spec repo's
// conformance/ directory) or the local-dev sibling path (the
// run-conformance convention); the suite skips when absent.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BINDING_SPEC, BINDING_SPEC_V2, BINDING_SPEC_V3, BINDING_SPEC_V4, LEGACY_BINDING_SPEC } from "./constants.js";
import { loadOpenAPIDocument, parseRef, validateDocumentAddress, errorMessage } from "./util.js";

const FAMILY = "openapi";

function corpusDir(): string | undefined {
  const root =
    process.env.OB_SPEC_CORPUS ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
  const dir = path.join(root, "binding-specs", FAMILY);
  return existsSync(dir) ? dir : undefined;
}

// Fixture shapes per conformance/binding-specs/fixture.schema.json. The
// document is kept as parsed JSON: `content !== undefined` asks member
// PRESENCE (`content: null` is a present member per the core §7 presence
// rule), and an omitted binding ref is distinct from a present empty string.
interface CorpusFixture {
  rule: string;
  bindingSpec: string;
  tests: CorpusTest[];
}
interface CorpusTest {
  description: string;
  document: CorpusDocument;
  valid: boolean;
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
  ref?: string;
}

/**
 * Routes one embedded OBI document's family-scoped material through this
 * package's offline lanes, returning the first refusal message or
 * undefined when there is nothing to refuse.
 */
async function judgeDocument(doc: CorpusDocument): Promise<string | undefined> {
  for (const [name, src] of Object.entries(doc.sources ?? {})) {
    if (src.bindingSpec !== BINDING_SPEC && src.bindingSpec !== BINDING_SPEC_V4 && src.bindingSpec !== BINDING_SPEC_V3 && src.bindingSpec !== BINDING_SPEC_V2 && src.bindingSpec !== LEGACY_BINDING_SPEC) continue;

    // Content lane (OAPI-D-01): a present member — null included — must be
    // the parsed document object or its source text. External refs are
    // disabled, so the load performs no I/O (fixtures are self-contained).
    let parsed: Record<string, unknown> | undefined;
    if (src.content !== undefined) {
      try {
        parsed = await loadOpenAPIDocument(undefined, src.content, {
          allowExternalRefs: false,
        });
      } catch (e: unknown) {
        return errorMessage(e);
      }
    }

    // Location lane (OAPI-D-02): grammar only, never dereferenced.
    if (src.location !== undefined) {
      try {
        validateDocumentAddress(src.location);
      } catch (e: unknown) {
        return errorMessage(e);
      }
    }

    // Ref lane (OAPI-D-03): ref is REQUIRED (an omitted ref reaches the
    // invoker as the empty string and is refused by the same grammar);
    // pointer evaluation follows OAS reference resolution — the loader
    // dereferences path-item $refs (3.1 components.pathItems included)
    // before the lookup, exactly as runBinding does.
    for (const b of Object.values(doc.bindings ?? {})) {
      if (b.source !== name) continue;
      let target: { path: string; method: string };
      try {
        target = parseRef(b.ref ?? "");
      } catch (e: unknown) {
        return errorMessage(e);
      }
      if (!parsed) continue; // location-only source: grammar-checked alone
      const paths = parsed.paths as Record<string, Record<string, unknown>> | undefined;
      const pathItem = paths?.[target.path];
      if (!pathItem) return `path "${target.path}" not in OpenAPI doc`;
      if (pathItem[target.method] == null) {
        return `method "${target.method}" not in path "${target.path}"`;
      }
    }
  }
  return undefined;
}

const dir = corpusDir();

// OB_CORPUS_REQUIRED (set in CI) turns a missing corpus into a hard failure
// so a mis-wired path or missing checkout turns CI red instead of silently
// green; unset (local dev) the suite still skips.
if (!dir && process.env.OB_CORPUS_REQUIRED) {
  throw new Error(
    "binding-specs conformance corpus required (OB_CORPUS_REQUIRED is set) but not located; " +
      "set OB_SPEC_CORPUS to the spec repo's conformance dir",
  );
}

describe.skipIf(!dir)("binding-spec conformance corpus (openapi)", () => {
  // skipIf marks the tests skipped, but this callback still RUNS at
  // collection time — without the corpus checkout (CI) the filesystem
  // reads below would crash the suite instead of skipping it.
  if (!dir) return;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const fixture = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as CorpusFixture;
    expect([BINDING_SPEC, BINDING_SPEC_V4, BINDING_SPEC_V3, BINDING_SPEC_V2]).toContain(fixture.bindingSpec);
    describe(fixture.rule, () => {
      for (const t of fixture.tests) {
        it(t.description, async () => {
          const refusal = await judgeDocument(t.document);
          if (t.valid && refusal !== undefined) {
            expect.fail(`expected nothing to refuse, got: ${refusal}`);
          }
          if (!t.valid && refusal === undefined) {
            expect.fail("expected a bind-time refusal, but the family-scoped material was accepted");
          }
        });
      }
    });
  }
});

// Binding-specification conformance corpus adapter: runs the spec
// repository's binding-specs/asyncapi fixtures (ASYNC-D-01..03) through
// this package's own offline lanes — content load, location grammar, and
// ref grammar/resolution — under the subcorpus README's verdict semantics:
// valid:false means a conformant openbindings.asyncapi@2 processor refuses
// the document's family-scoped material at or before bind time, decidable
// offline with no network and no live source. Positive location-only
// fixtures are judged by grammar alone (never dereferenced), and the
// content lane loads with a rejecting fetch, so the run performs no I/O
// beyond reading the fixtures. Mirrors the Go SDK's
// formats/asyncapi/corpus_test.go.
//
// The corpus root is located via OB_SPEC_CORPUS (the spec repo's
// conformance/ directory) or the local-dev sibling path (the
// run-conformance convention); the suite skips when absent.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BINDING_SPEC } from "./constants.js";
import { errorMessage, parseAsyncAPIDocument, parseRef, validateDocumentAddress } from "./util.js";
import type { AsyncAPIDocument } from "./asyncapi-types.js";

const FAMILY = "asyncapi";

function corpusDir(): string | undefined {
  const root =
    process.env.OB_SPEC_CORPUS ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
  const dir = path.join(root, "binding-specs", FAMILY);
  return existsSync(dir) ? dir : undefined;
}

/** Any external $ref fetch is a harness bug: the corpus is judged offline. */
const rejectingFetch = (() => {
  throw new Error("offline corpus judge must not fetch");
}) as unknown as typeof globalThis.fetch;

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
    if (src.bindingSpec !== BINDING_SPEC) continue;

    // Content lane (ASYNC-D-01): a present member — null included — must
    // be the parsed document object or its source text. The rejecting
    // fetch keeps the load side-effect-free (fixtures are self-contained).
    let parsed: AsyncAPIDocument | undefined;
    if (src.content !== undefined) {
      try {
        parsed = await parseAsyncAPIDocument(undefined, src.content, {}, rejectingFetch);
      } catch (e: unknown) {
        return errorMessage(e);
      }
    }

    // Location lane (ASYNC-D-02): grammar only, never dereferenced.
    if (src.location !== undefined) {
      try {
        validateDocumentAddress(src.location);
      } catch (e: unknown) {
        return errorMessage(e);
      }
    }

    // Ref lane (ASYNC-D-03): ref is REQUIRED (an omitted ref reaches the
    // invoker as the empty string and is refused by the same grammar);
    // against an embedded artifact the pointer must address an
    // operations-map entry, with Reference Objects resolved through before
    // the operation-object test (the shared dereferencer resolves them at
    // load) — exactly as runBinding judges.
    for (const b of Object.values(doc.bindings ?? {})) {
      if (b.source !== name) continue;
      let opID: string;
      try {
        opID = parseRef(b.ref ?? "");
      } catch (e: unknown) {
        return errorMessage(e);
      }
      if (!parsed) continue; // location-only source: grammar-checked alone
      const op = parsed.operations?.[opID];
      if (!op) return `operation "${opID}" not in AsyncAPI doc`;
      if (typeof op === "object" && "$ref" in (op as unknown as Record<string, unknown>)) {
        return `operation "${opID}" is a Reference Object that did not resolve`;
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

describe.skipIf(!dir)("binding-spec conformance corpus (asyncapi)", () => {
  // skipIf marks the tests skipped, but this callback still RUNS at
  // collection time — without the corpus checkout (CI) the filesystem
  // reads below would crash the suite instead of skipping it.
  if (!dir) return;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const fixture = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as CorpusFixture;
    expect(fixture.bindingSpec).toBe(BINDING_SPEC);
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

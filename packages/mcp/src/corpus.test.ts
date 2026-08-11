// Binding-specification conformance corpus adapter: runs the spec
// repository's binding-specs/mcp fixtures (MCP-D-01..03) through this
// package's own offline lanes — pinned-listing validation, endpoint
// grammar, and ref grammar/resolution — under the subcorpus README's
// verdict semantics: valid:false means a conformant openbindings.mcp@1
// processor refuses the document's family-scoped material at or before
// bind time, decidable offline with no network and no live source.
// Positive location-only fixtures are judged by grammar alone (never
// connected), so the run performs no I/O beyond reading the fixtures.
// Mirrors the Go SDK's formats/mcp/corpus_test.go.
//
// The corpus root is located via OB_SPEC_CORPUS (the spec repo's
// conformance/ directory) or the local-dev sibling path (the
// run-conformance convention); the suite skips when absent.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BINDING_SPEC } from "./constants.js";
import { parseRef, validateEndpoint } from "./invoke.js";
import { parsePinnedListing, resolveRef, type Listing } from "./listing.js";

const FAMILY = "mcp";

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
function judgeDocument(doc: CorpusDocument): string | undefined {
  for (const [name, src] of Object.entries(doc.sources ?? {})) {
    if (src.bindingSpec !== BINDING_SPEC) continue;

    // Content lane (MCP-D-01): a present member — null included — must be
    // a pinned listing.
    let pin: Listing | undefined;
    if (src.content !== undefined) {
      try {
        pin = parsePinnedListing(src.content);
      } catch (e: unknown) {
        return e instanceof Error ? e.message : String(e);
      }
    }

    // Location lane (MCP-D-02): REQUIRED — a content-only source addresses
    // nothing — and an absolute http/https URI. Grammar only, never
    // connected.
    try {
      validateEndpoint(src.location);
    } catch (e: unknown) {
      return e instanceof Error ? e.message : String(e);
    }

    // Ref lane (MCP-D-03): ref is REQUIRED (an omitted ref reaches the
    // invoker as the empty string and is refused by the same grammar);
    // with a pin, resolution is offline — byte-exact and
    // multiplicity-aware, exactly as runMCPBinding does before any
    // connection.
    for (const b of Object.values(doc.bindings ?? {})) {
      if (b.source !== name) continue;
      let entityType: string;
      let remainder: string;
      try {
        ({ entityType, name: remainder } = parseRef(b.ref ?? ""));
      } catch (e: unknown) {
        return e instanceof Error ? e.message : String(e);
      }
      if (entityType !== "tools") {
        return `openbindings.mcp@1 ref must use tools/<name>, got ${JSON.stringify(b.ref ?? "")}`;
      }
      if (pin) {
        try {
          resolveRef(pin, entityType, remainder, BINDING_SPEC);
        } catch (e: unknown) {
          return e instanceof Error ? e.message : String(e);
        }
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

describe.skipIf(!dir)("binding-spec conformance corpus (mcp)", () => {
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
        it(t.description, () => {
          const refusal = judgeDocument(t.document);
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

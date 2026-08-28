// Core-level checks over the spec repository's binding-specs subcorpus
// (conformance/binding-specs/<family>/*.json — the family D-rule fixtures).
//
// The subcorpus README pins that every fixture document is an otherwise
// valid 0.2.0 OBI document: in negative cases the named FAMILY rule is the
// only thing at issue, except where an overlap with a core rule is
// inherent (a relative-in-form location also violates core OBI-D-05; such
// fixtures list both in `violates`). That gives the core SDK two claims it
// can judge without any family processor:
//
//   - every POSITIVE fixture document is core-valid (validateDocument
//     accepts it), and
//   - every negative fixture whose `violates` names a core OBI rule is
//     refused by validateDocument.
//
// Negative fixtures violating only family rules are outside core's
// authority (core neither accepts nor refuses on the family's behalf) and
// carry no core-level assertion here.
//
// FAMILY-LANE coverage (routing each fixture through the family's own
// loader/validator) lives with every published family package's
// corpus.test.ts. Keeping those assertions beside the implementation makes
// it impossible for a newly implemented family to appear covered merely
// because its documents remain core-valid.
//
// The corpus root is located via OB_SPEC_CORPUS (the spec repo's
// conformance/ directory) or the local-dev sibling path (the
// run-conformance convention); the suite skips when absent.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateDocument } from "./parse.js";

const ALL_FAMILIES = [
  "asyncapi",
  "connect",
  "graphql",
  "grpc",
  "mcp",
  "openapi-2.0",
  "openapi-3.0",
  "openapi-3.1",
  "openapi-3.2",
  "usage",
] as const;

function corpusRoot(): string | undefined {
  const root =
    process.env.OB_SPEC_CORPUS ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
  return existsSync(path.join(root, "binding-specs")) ? root : undefined;
}

interface CorpusFixture {
  rule: string;
  tests: {
    description: string;
    document: unknown;
    valid: boolean;
    violates?: string[];
  }[];
}

const root = corpusRoot();

// OB_CORPUS_REQUIRED (set in CI) turns a missing corpus into a hard failure
// so a mis-wired path or missing checkout turns CI red instead of silently
// green; unset (local dev) the suite still skips.
if (!root && process.env.OB_CORPUS_REQUIRED) {
  throw new Error(
    "binding-specs conformance corpus required (OB_CORPUS_REQUIRED is set) but not located; " +
      "set OB_SPEC_CORPUS to the spec repo's conformance dir",
  );
}

describe.skipIf(!root)("binding-specs subcorpus, core-level checks", () => {
  // skipIf marks the tests skipped, but this callback still RUNS at
  // collection time — without the corpus checkout (CI) the filesystem
  // reads below would crash the suite instead of skipping it.
  if (!root) return;
  for (const family of ALL_FAMILIES) {
    describe(family, () => {
      const dir = path.join(root, "binding-specs", family);
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
      expect(files.length).toBeGreaterThan(0);

      for (const file of files) {
        const fixture = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as CorpusFixture;
        for (const t of fixture.tests) {
          const violatesCore = (t.violates ?? []).some((r) => r.startsWith("OBI-"));
          if (t.valid) {
            it(`${fixture.rule}: core-valid positive — ${t.description}`, () => {
              expect(() => validateDocument(JSON.stringify(t.document))).not.toThrow();
            });
          } else if (violatesCore) {
            it(`${fixture.rule}: core refusal (inherent overlap) — ${t.description}`, () => {
              expect(() => validateDocument(JSON.stringify(t.document))).toThrow();
            });
          }
          // Family-only negatives carry no core-level claim.
        }
      }
    });
  }
});

/**
 * Conformance corpus adapter for the format-neutral invariants of the
 * interface-synthesizer coverage contract. Binding-family interaction
 * inventories remain in the spec repository's synthesis scenarios.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  finalizeSynthesisCoverage,
  type SynthesisCoverageEntry,
} from "./synthesizer-types.js";
import { validateDocument } from "@openbindings/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const corpusDir =
  process.env.OB_INTERFACES_CORPUS ??
  resolve(__dirname, "..", "..", "..", "..", "interfaces", "conformance");
const corpusPath = join(corpusDir, "synthesis-coverage", "cases.json");
const corpusExists = existsSync(corpusPath);

if (!corpusExists && process.env.OB_CORPUS_REQUIRED) {
  throw new Error(
    "interfaces synthesis-coverage corpus required (OB_CORPUS_REQUIRED is set) but not located; " +
      "set OB_INTERFACES_CORPUS to the interfaces repo's conformance dir",
  );
}

interface SynthesisCoverageCase {
  description: string;
  interface: Record<string, unknown>;
  entries: SynthesisCoverageEntry[];
  exhaustive: boolean;
  expected: {
    valid: boolean;
    fullyRepresented?: boolean;
    errorContains?: string;
  };
}

interface SynthesisCoverageCorpus {
  tests: SynthesisCoverageCase[];
}

describe.skipIf(!corpusExists)("conformance corpus: interface synthesis coverage", () => {
  if (!corpusExists) return;
  const corpus = JSON.parse(
    readFileSync(corpusPath, "utf8"),
  ) as SynthesisCoverageCorpus;
  expect(corpus.tests.length).toBeGreaterThan(0);

  for (const tc of corpus.tests) {
    it(tc.description, () => {
      const iface = validateDocument(JSON.stringify(tc.interface));
      if (!tc.expected.valid) {
        expect(() =>
          finalizeSynthesisCoverage(iface, tc.entries, tc.exhaustive)
        ).toThrow(tc.expected.errorContains);
        return;
      }
      const result = finalizeSynthesisCoverage(iface, tc.entries, tc.exhaustive);
      expect(result.coverage.fullyRepresented).toBe(tc.expected.fullyRepresented);
    });
  }
});

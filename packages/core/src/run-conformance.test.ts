/**
 * Unit test for the conformance runner's `requiresSupports` gate: the corpus
 * annotation "administer this test only to tools whose OBI-T-04
 * version-acceptance predicate accepts X.Y.Z; otherwise SKIP and report the
 * skip separately (skips are never failures)". For this SDK the predicate is
 * `isSupportedVersion`.
 *
 * The runner (scripts/run-conformance.ts) is exercised through the same seam
 * CI uses — `--corpus=<dir> --json` — against a SYNTHETIC corpus in a temp
 * directory, so this test does not depend on the spec repository's corpus
 * carrying the annotation. The skip-side fixtures are booby-trapped (a
 * `valid: true` verdict over a non-OBI document): if the gate failed to skip
 * them they would run, mismatch, and flip the runner's exit code to 1.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_TESTED_VERSION } from "./version.js";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runner = join(pkgRoot, "scripts", "run-conformance.ts");

// Both sides of the OBI-T-04 acceptance boundary, pinned relative to the
// SDK's own constants so the fixture cannot rot when the range moves.
// MAX_TESTED_VERSION is 0.x: acceptance is patch-lenient within the tested
// minor line and refuses any other pre-1.0 minor, in both directions.
// MAX_TESTED_VERSION is a SemVer constant, so both components always exist;
// the NaN defaults would only fire (and fail the fixtures loudly) if it rotted.
const [major = NaN, minor = NaN] = MAX_TESTED_VERSION.split(".").map(Number);
const acceptedExact = MAX_TESTED_VERSION; // accepted: the tested version itself
const acceptedPatchAbove = `${major}.${minor}.99`; // accepted: higher patch, same minor
const refusedMinorAbove = `${major}.${minor + 1}.0`; // refused: higher pre-1.0 minor
const refusedMinorBelow = `${major}.${minor - 1}.0`; // refused: lower pre-1.0 minor

const corpusDir = mkdtempSync(join(tmpdir(), "ob-synthetic-corpus-"));

afterAll(() => {
  rmSync(corpusDir, { recursive: true, force: true });
});

describe("run-conformance requiresSupports gate", () => {
  it(
    "administers accepted-version tests and skips refused-version tests (skips are never failures)",
    () => {
      const fixture = {
        rule: "SYN-GATE",
        section: "synthetic",
        description: "synthetic requiresSupports fixture (harness unit test; not a corpus rule)",
        tests: [
          {
            description: "accepted: annotation names the tested version — runs",
            requiresSupports: acceptedExact,
            valid: true,
            document: { openbindings: MAX_TESTED_VERSION, operations: {} },
          },
          {
            description: "accepted: higher patch within the tested minor line — runs",
            requiresSupports: acceptedPatchAbove,
            valid: false,
            document: { openbindings: MAX_TESTED_VERSION }, // missing `operations`: refused if run
          },
          {
            description: "refused: higher pre-1.0 minor — skips",
            requiresSupports: refusedMinorAbove,
            valid: true,
            document: { synthetic: "not an OBI document; would FAIL if administered" },
          },
          {
            description: "refused: lower pre-1.0 minor — skips",
            requiresSupports: refusedMinorBelow,
            valid: true,
            document: { synthetic: "not an OBI document; would FAIL if administered" },
          },
        ],
      };
      mkdirSync(join(corpusDir, "document"), { recursive: true });
      writeFileSync(join(corpusDir, "document", "SYN-GATE.json"), JSON.stringify(fixture, null, 2));

      // execFileSync throws on a non-zero exit, so mere success asserts the
      // runner exited 0 with two tests skipped — skips are never failures.
      const out = execFileSync(
        process.execPath,
        ["--import", "tsx", runner, `--corpus=${corpusDir}`, "--json"],
        { cwd: pkgRoot, encoding: "utf8" },
      );
      const report = JSON.parse(out) as {
        total: number;
        passed: number;
        failed: number;
        skipped: number;
        byRule: Record<string, { total: number; passed: number; skipped: number }>;
        mismatches: unknown[];
      };

      // failed === 0 proves both booby-trapped refused-side tests were the
      // ones skipped; passed === 2 proves both accepted-side tests were
      // administered (a skipped test never counts as passed).
      expect(report.total).toBe(4);
      expect(report.passed).toBe(2);
      expect(report.failed).toBe(0);
      expect(report.skipped).toBe(2);
      expect(report.mismatches).toEqual([]);
      expect(report.byRule["SYN-GATE"]).toEqual({ total: 4, passed: 2, skipped: 2 });
    },
    60_000, // subprocess pays tsx compile cost on first run
  );
});

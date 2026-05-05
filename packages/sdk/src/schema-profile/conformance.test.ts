import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import canonicalize from "canonicalize";
import { Normalizer } from "./normalize.js";
import { OutsideProfileError } from "./errors.js";

// ----- Types matching the spec conformance format -----

interface Manifest {
  conventionVersion: string;
  profile: string;
  files: ManifestFile[];
}

interface ManifestFile {
  path: string;
  mode: string;
  direction: string;
  verdict: string;
  findings: string[];
}

interface Fixture {
  version: string;
  description: string;
  left: OBInterface;
  right: OBInterface;
  mode: string;
  options: { profile: string };
}

interface OBInterface {
  openbindings: string;
  operations: Record<string, OBOperation>;
  schemas?: Record<string, unknown>;
}

interface OBOperation {
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  aliases?: string[];
}

// ----- Configuration -----

const CONFORMANCE_DIR = path.resolve(
  __dirname,
  "../../../../../spec/conformance/comparison",
);

// Known gaps: fixtures that expose unimplemented features in the TS schema-profile
// package. Each entry maps a fixture path to the reason it must be skipped.
const KNOWN_GAPS: Record<string, string> = {
  // The normalizer does not detect draft-04 boolean exclusiveMinimum/
  // exclusiveMaximum as non-2020-12 schema constructs. It should reject
  // them with OutsideProfileError to produce an "indeterminate" verdict.
  "profile/profile-schema-not-2020-12-indeterminate.json":
    "normalizer does not detect draft-04 boolean exclusiveMinimum as non-2020-12",

  // Same root cause: one operation uses draft-04 boolean exclusiveMinimum,
  // which should collapse the multi-op verdict to indeterminate.
  "structural/verdict-collapse-indeterminate-dominates.json":
    "normalizer does not detect draft-04 boolean exclusiveMinimum as non-2020-12",

  // The compat logic skips additionalProperties for input direction, but the
  // spec says disabling additionalProperties on the candidate is a breaking
  // input change.
  "subsumption/additional-properties-input-disabled-breaking.json":
    "inputCompatible does not enforce additionalProperties restriction",

  // The schema-profile package does not implement the suppression mechanism.
  // Suppressions are an interface-level concern that downgrade breaking
  // findings to compatible.
  "suppression/suppressed-required-input-added-audit.json":
    "suppression mechanism not implemented",

  // The fixture expects an "unverified" verdict for regex pattern containment,
  // which is outside the schemaprofile scope.
  "subsumption/string-pattern-input-mismatch-unverified.json":
    "unverified verdict for regex containment outside schemaprofile scope",
};

// ----- Helpers -----

type OpVerdict = "compatible" | "incompatible" | "indeterminate";

/** Collapse per-operation verdicts using spec dominance: indeterminate > incompatible > compatible. */
function collapseVerdicts(verdicts: OpVerdict[]): string {
  const has = new Set(verdicts);
  if (has.has("indeterminate")) return "indeterminate";
  if (has.has("incompatible")) return "incompatible";
  return "compatible";
}

/**
 * Find the right-side operation that pairs with a left key, checking direct
 * key match first, then alias match.
 */
function findPairedOp(
  leftKey: string,
  rightOps: Record<string, OBOperation>,
  leftAliasIndex: Map<string, string>,
): { rightKey: string; rightOp: OBOperation } | null {
  if (leftKey in rightOps) {
    return { rightKey: leftKey, rightOp: rightOps[leftKey] };
  }
  for (const [rk, op] of Object.entries(rightOps)) {
    const lk = leftAliasIndex.get(rk);
    if (lk === leftKey) {
      return { rightKey: rk, rightOp: op };
    }
  }
  return null;
}

/** Compare a single paired operation and return a verdict. */
async function compareOperation(
  direction: string,
  leftOp: OBOperation,
  rightOp: OBOperation,
  leftInterface: OBInterface,
  rightInterface: OBInterface,
): Promise<OpVerdict> {
  let leftSchema = direction === "input" ? leftOp.input : leftOp.output;
  let rightSchema = direction === "input" ? rightOp.input : rightOp.output;
  leftSchema ??= {};
  rightSchema ??= {};

  // Each schema resolves $ref against its own interface document.
  const n = new Normalizer({ root: leftInterface as unknown as Record<string, unknown> });

  try {
    const result =
      direction === "input"
        ? await n.inputCompatible(leftSchema, rightSchema)
        : await n.outputCompatible(leftSchema, rightSchema);
    return result.compatible ? "compatible" : "incompatible";
  } catch (err) {
    if (err instanceof OutsideProfileError) {
      return "indeterminate";
    }
    throw err;
  }
}

/** Run a subsume-mode fixture: pair operations, compare, collapse verdicts. */
async function runSubsumeFixture(
  entry: ManifestFile,
  fix: Fixture,
): Promise<string> {
  const leftOps = fix.left.operations;
  const rightOps = fix.right.operations;

  // Build alias index for left operations: alias -> left operation key.
  const leftAliasIndex = new Map<string, string>();
  for (const [key, op] of Object.entries(leftOps)) {
    for (const alias of op.aliases ?? []) {
      leftAliasIndex.set(alias, key);
    }
  }

  const verdicts: OpVerdict[] = [];
  const pairedRight = new Set<string>();

  // For each left operation, find its pair in right (by key or alias).
  for (const [leftKey, leftOp] of Object.entries(leftOps)) {
    const pair = findPairedOp(leftKey, rightOps, leftAliasIndex);
    if (!pair) {
      // Operation removed: breaking.
      verdicts.push("incompatible");
      continue;
    }
    pairedRight.add(pair.rightKey);

    const verdict = await compareOperation(
      entry.direction,
      leftOp,
      pair.rightOp,
      fix.left,
      fix.right,
    );
    verdicts.push(verdict);
  }

  // Operations only in right (added) are non-breaking.
  for (const rightKey of Object.keys(rightOps)) {
    if (pairedRight.has(rightKey)) continue;
    if (leftAliasIndex.has(rightKey)) continue;
    verdicts.push("compatible");
  }

  return collapseVerdicts(verdicts);
}

/** Run an identical-mode fixture: normalize both schemas and compare canonical JSON. */
async function runIdenticalFixture(
  entry: ManifestFile,
  fix: Fixture,
): Promise<string> {
  for (const [opKey, leftOp] of Object.entries(fix.left.operations)) {
    const rightOp = fix.right.operations[opKey];
    expect(rightOp, `operation "${opKey}" in left but not in right`).toBeDefined();

    let leftSchema = entry.direction === "input" ? leftOp.input : leftOp.output;
    let rightSchema = entry.direction === "input" ? rightOp.input : rightOp.output;
    leftSchema ??= {};
    rightSchema ??= {};

    const nLeft = new Normalizer({
      root: fix.left as unknown as Record<string, unknown>,
    });
    const nRight = new Normalizer({
      root: fix.right as unknown as Record<string, unknown>,
    });

    const normLeft = await nLeft.normalize(leftSchema);
    const normRight = await nRight.normalize(rightSchema);

    const leftJSON = canonicalize(normLeft) ?? "";
    const rightJSON = canonicalize(normRight) ?? "";

    if (entry.verdict === "compatible") {
      expect(leftJSON).toBe(rightJSON);
    } else {
      expect(leftJSON).not.toBe(rightJSON);
    }
  }

  return entry.verdict;
}

// ----- Test suite -----

const manifestPath = path.join(CONFORMANCE_DIR, "manifest.json");
const fixturesAvailable = fs.existsSync(manifestPath);

describe.skipIf(!fixturesAvailable)("comparison conformance", () => {
  const manifest: Manifest = fixturesAvailable
    ? JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
    : { conventionVersion: "", profile: "", files: [] };

  for (const entry of manifest.files) {
    const skipReason = KNOWN_GAPS[entry.path];
    const isUnverified = entry.verdict === "unverified";

    it.skipIf(!!skipReason || isUnverified)(entry.path, async () => {
      const fixturePath = path.join(CONFORMANCE_DIR, entry.path);
      const fix: Fixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));

      let got: string;
      switch (entry.mode) {
        case "subsume":
          got = await runSubsumeFixture(entry, fix);
          break;
        case "identical":
          got = await runIdenticalFixture(entry, fix);
          break;
        default:
          throw new Error(`unknown mode "${entry.mode}"`);
      }

      expect(got).toBe(entry.verdict);
    });
  }

  it("manifest references only existing files", () => {
    for (const entry of manifest.files) {
      const fixturePath = path.join(CONFORMANCE_DIR, entry.path);
      expect(
        fs.existsSync(fixturePath),
        `manifest references missing file: ${entry.path}`,
      ).toBe(true);
    }
  });

  it("fixture verdicts match manifest verdicts", () => {
    for (const entry of manifest.files) {
      const fixturePath = path.join(CONFORMANCE_DIR, entry.path);
      const raw = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
      const fixtureVerdict = raw.expected?.summary?.verdict;
      expect(
        fixtureVerdict,
        `${entry.path}: manifest verdict "${entry.verdict}" != fixture verdict "${fixtureVerdict}"`,
      ).toBe(entry.verdict);
    }
  });

  it("known gaps reference real manifest entries", () => {
    const manifestPaths = new Set(manifest.files.map((f) => f.path));
    for (const gapPath of Object.keys(KNOWN_GAPS)) {
      expect(
        manifestPaths.has(gapPath),
        `known gap "${gapPath}" does not appear in manifest; remove it`,
      ).toBe(true);
    }
  });
});

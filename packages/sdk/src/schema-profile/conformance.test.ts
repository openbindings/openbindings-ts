/**
 * Conformance corpus adapter: runs this package's normalization and
 * directional compatibility checks against the interfaces repository's
 * schema-comparison corpus unmodified (conformance/comparison — the
 * schema-comparison profile's fail-closed boundary, normalization
 * equivalence, directional subsumption, boolean schema forms, and the
 * unspecified-schema suppression rule).
 *
 * The corpus is located via OB_INTERFACES_CORPUS or the local-dev sibling
 * path (openbindings/interfaces next to openbindings/openbindings-ts); the
 * suite skips when it is absent.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import canonicalize from "canonicalize";
import { Normalizer } from "./normalize.js";
import { inputCompatible, outputCompatible } from "./compat.js";
import { OutsideProfileError } from "./errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ----- Types matching the corpus conventions -----
// (interfaces/conformance/comparison/manifest.schema.json and fixture.schema.json)

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
  expected?: { summary?: { verdict?: string } };
}

interface OBInterface {
  openbindings: string;
  operations: Record<string, OBOperation>;
  schemas?: Record<string, unknown>;
}

// Schema slots are `unknown` because fixtures may use either JSON Schema
// form: an object, or a boolean (§5.2). Absent slots mean unspecified.
interface OBOperation {
  input?: unknown;
  output?: unknown;
  aliases?: string[];
}

// ----- Corpus location -----

/**
 * Locates the interfaces conformance corpus: the OB_INTERFACES_CORPUS
 * environment variable, or the local-dev sibling checkout. Same convention
 * as selection-corpus.test.ts.
 */
function corpusDir(): string | null {
  const dir =
    process.env.OB_INTERFACES_CORPUS ??
    resolve(__dirname, "..", "..", "..", "..", "..", "interfaces", "conformance");
  return existsSync(dir) ? dir : null;
}

// ----- Helpers -----

type OpVerdict = "compatible" | "incompatible" | "indeterminate";

/** Collapse per-operation verdicts using the profile's dominance: indeterminate > incompatible > compatible. */
function collapseVerdicts(verdicts: OpVerdict[]): string {
  const has = new Set(verdicts);
  if (has.has("indeterminate")) return "indeterminate";
  if (has.has("incompatible")) return "incompatible";
  return "compatible";
}

/**
 * Maps a fixture schema value to the object form the profile compares: an
 * object schema as itself, boolean `true` as `{}`, and boolean `false` as
 * `{"not": {}}` — the same equivalent spellings schemaObjectForm applies at
 * the compatibility layer.
 */
function fixtureSchemaObjectForm(v: unknown): Record<string, unknown> | undefined {
  if (typeof v === "boolean") {
    return v ? {} : { not: {} };
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return undefined;
}

function directionSchema(direction: string, op: OBOperation): unknown {
  return direction === "input" ? op.input : op.output;
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
  const direct = rightOps[leftKey];
  if (direct) {
    return { rightKey: leftKey, rightOp: direct };
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
  const leftRaw = directionSchema(direction, leftOp);
  const rightRaw = directionSchema(direction, rightOp);

  // An absent schema is unspecified, not Top: the slot's comparison is
  // skipped and reports no finding — the profile's suppression rule, the
  // same treatment checkInterfaceCompatibility applies.
  if (leftRaw == null || rightRaw == null) return "compatible";

  const leftSchema = fixtureSchemaObjectForm(leftRaw);
  const rightSchema = fixtureSchemaObjectForm(rightRaw);
  expect(leftSchema, "left schema must be an object or boolean").toBeDefined();
  expect(rightSchema, "right schema must be an object or boolean").toBeDefined();

  // Each schema resolves $ref against its OWN interface document: the left
  // schema normalizes against the left document root, the right schema
  // against the right document root, and the pre-normalized pair runs the
  // package-level directional check — the same per-side rooting
  // checkInterfaceCompatibility applies.
  const nLeft = new Normalizer({ root: leftInterface as unknown as Record<string, unknown> });
  const nRight = new Normalizer({ root: rightInterface as unknown as Record<string, unknown> });

  try {
    const leftNorm = await nLeft.normalize(leftSchema!);
    const rightNorm = await nRight.normalize(rightSchema!);
    const result =
      direction === "input"
        ? inputCompatible(leftNorm, rightNorm)
        : outputCompatible(leftNorm, rightNorm);
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

    const verdict = await compareOperation(entry.direction, leftOp, pair.rightOp, fix.left, fix.right);
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
    if (!rightOp) throw new Error(`operation "${opKey}" in left but not in right`);

    const leftSchema = fixtureSchemaObjectForm(directionSchema(entry.direction, leftOp)) ?? {};
    const rightSchema = fixtureSchemaObjectForm(directionSchema(entry.direction, rightOp)) ?? {};

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

const dir = corpusDir();
const comparisonDir = dir ? join(dir, "comparison") : null;
const manifestPath = comparisonDir ? join(comparisonDir, "manifest.json") : null;
const fixturesAvailable = manifestPath !== null && existsSync(manifestPath);

// OB_CORPUS_REQUIRED (set in CI) turns a missing corpus into a hard failure
// so a mis-wired path or missing checkout turns CI red instead of silently
// green; unset (local dev) the suite still skips.
if (!fixturesAvailable && process.env.OB_CORPUS_REQUIRED) {
  throw new Error(
    "comparison conformance corpus required (OB_CORPUS_REQUIRED is set) but not located; " +
      "set OB_INTERFACES_CORPUS to the interfaces repo's conformance dir",
  );
}

describe.skipIf(!fixturesAvailable)("comparison conformance", () => {
  const manifest: Manifest = fixturesAvailable
    ? JSON.parse(readFileSync(manifestPath, "utf-8"))
    : { conventionVersion: "", profile: "", files: [] };

  for (const entry of manifest.files) {
    it(entry.path, async () => {
      const fixturePath = join(comparisonDir!, entry.path);
      const fix: Fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));

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
    expect(manifest.files.length).toBeGreaterThan(0);
    for (const entry of manifest.files) {
      const fixturePath = join(comparisonDir!, entry.path);
      expect(
        existsSync(fixturePath),
        `manifest references missing file: ${entry.path}`,
      ).toBe(true);
    }
  });

  it("fixture verdicts match manifest verdicts", () => {
    for (const entry of manifest.files) {
      const fixturePath = join(comparisonDir!, entry.path);
      const raw = JSON.parse(readFileSync(fixturePath, "utf-8"));
      const fixtureVerdict = raw.expected?.summary?.verdict;
      expect(
        fixtureVerdict,
        `${entry.path}: manifest verdict "${entry.verdict}" != fixture verdict "${fixtureVerdict}"`,
      ).toBe(entry.verdict);
    }
  });
});

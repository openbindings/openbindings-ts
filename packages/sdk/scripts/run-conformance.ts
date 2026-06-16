/**
 * Reference conformance runner for the OpenBindings TypeScript SDK.
 *
 * Walks fixture files under <corpus>/{document,tool}/, parses AND validates
 * each embedded `document` with @openbindings/sdk (validateDocument =
 * parseDocument + validateInterface, so the full OBI-D rule walk runs), and
 * compares the SDK's verdict against the fixture's `valid` field.
 *
 * Each SDK runs the corpus independently — there is no single cross-SDK CI
 * job. The corpus lives in the spec repo (../../../spec/conformance by
 * default) so SDKs can pull a known version and pin behavior.
 *
 * Usage:
 *   pnpm conformance                     # all fixtures
 *   pnpm conformance -- --rule=OBI-D-03  # single rule
 *   pnpm conformance -- --verbose        # per-test output
 *   pnpm conformance -- --json           # machine-readable
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateDocument,
  isHigherMajorOrPre1MinorThanMaxTested,
  MAX_TESTED_VERSION,
} from "../src/index.js";

interface FixtureTest {
  description: string;
  document: unknown;
  valid: boolean;
  violates?: string[];
  requiresMaxTested?: string;
}

interface Fixture {
  rule: string;
  section: string;
  description: string;
  notes?: string;
  tests: FixtureTest[];
}

interface Result {
  rule: string;
  test: string;
  passed: boolean;
  skipped: boolean;
  expected: boolean;
  actual: boolean;
  reason?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function findDefaultCorpus(): string {
  // ../../../../spec/conformance (from packages/sdk/scripts)
  const guesses = [
    join(__dirname, "..", "..", "..", "..", "spec", "conformance"),
    join(__dirname, "..", "..", "..", "spec", "conformance"),
    join(process.cwd(), "spec", "conformance"),
    join(process.cwd(), "..", "..", "spec", "conformance"),
  ];
  for (const g of guesses) {
    if (existsSync(g)) return g;
  }
  return "./conformance";
}

function listFixtures(root: string): string[] {
  const out: string[] = [];
  for (const sub of ["document", "tool"]) {
    const dir = join(root, sub);
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir)) {
      if (e.endsWith(".json")) out.push(join(dir, e));
    }
  }
  out.sort();
  return out;
}

function resolveCorpusDir(input: string): string {
  if (existsSync(input) || isAbsolute(input)) return input;
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, input);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return input;
    dir = parent;
  }
}

function runOne(rule: string, t: FixtureTest): Result {
  if (t.requiresMaxTested) {
    try {
      if (isHigherMajorOrPre1MinorThanMaxTested(t.requiresMaxTested)) {
        return {
          rule,
          test: t.description,
          passed: false,
          skipped: true,
          expected: t.valid,
          actual: false,
          reason: `requires SDK MaxTested >= ${t.requiresMaxTested}; current is ${MAX_TESTED_VERSION}`,
        };
      }
    } catch {
      // fall through and run normally
    }
  }
  let actual = false;
  let reason: string | undefined;
  try {
    validateDocument(JSON.stringify(t.document));
    actual = true;
  } catch (e) {
    reason = `parse/validate: ${(e as Error).message}`;
  }
  const passed = actual === t.valid;
  return {
    rule,
    test: t.description,
    passed,
    skipped: false,
    expected: t.valid,
    actual,
    reason: passed ? undefined : (reason ?? "SDK accepted; fixture expected reject"),
  };
}

function parseArgs(argv: string[]): { ruleFilter?: string; verbose: boolean; json: boolean; corpusDir: string } {
  let ruleFilter: string | undefined;
  let verbose = false;
  let json = false;
  let corpusDir = findDefaultCorpus();
  for (const a of argv) {
    if (a.startsWith("--rule=")) ruleFilter = a.slice("--rule=".length);
    else if (a === "--verbose") verbose = true;
    else if (a === "--json") json = true;
    else if (a.startsWith("--corpus=")) corpusDir = resolveCorpusDir(a.slice("--corpus=".length));
  }
  return { ruleFilter, verbose, json, corpusDir };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  let files = listFixtures(args.corpusDir);
  if (args.ruleFilter) {
    files = files.filter((f) => basename(f, ".json") === args.ruleFilter);
  }
  if (files.length === 0) {
    console.error(`no fixtures found under ${args.corpusDir}`);
    process.exit(2);
  }

  const results: Result[] = [];
  for (const f of files) {
    const data = readFileSync(f, "utf8");
    const fix = JSON.parse(data) as Fixture;
    for (const t of fix.tests) {
      results.push(runOne(fix.rule, t));
    }
  }

  let passed = 0,
    failed = 0,
    skipped = 0;
  const byRule = new Map<string, { total: number; passed: number; skipped: number }>();
  const mismatches: Result[] = [];
  for (const r of results) {
    const stat = byRule.get(r.rule) ?? { total: 0, passed: 0, skipped: 0 };
    stat.total++;
    if (r.skipped) {
      skipped++;
      stat.skipped++;
    } else if (r.passed) {
      passed++;
      stat.passed++;
    } else {
      failed++;
      mismatches.push(r);
    }
    byRule.set(r.rule, stat);
  }

  if (args.json) {
    console.log(JSON.stringify({ total: results.length, passed, failed, skipped, byRule: Object.fromEntries(byRule), mismatches }, null, 2));
    process.exit(failed > 0 ? 1 : 0);
  }

  if (skipped > 0) {
    console.log(`Conformance: ${passed}/${results.length - skipped} passed (${skipped} skipped)\n`);
  } else {
    console.log(`Conformance: ${passed}/${results.length} passed\n`);
  }
  if (args.verbose) {
    for (const r of results) {
      const status = r.skipped ? "SKIP" : r.passed ? "PASS" : "FAIL";
      console.log(`  [${status}] ${r.rule} :: ${r.test}`);
      if ((r.skipped || !r.passed) && r.reason) {
        console.log(`        ${r.reason.length > 200 ? r.reason.slice(0, 200) + "..." : r.reason}`);
      }
    }
    console.log();
  }
  console.log("By rule:");
  const rules = [...byRule.keys()].sort();
  for (const k of rules) {
    const s = byRule.get(k)!;
    if (s.skipped > 0) {
      console.log(`  ${k}: ${s.passed}/${s.total - s.skipped} (${s.skipped} skipped)`);
    } else {
      console.log(`  ${k}: ${s.passed}/${s.total}`);
    }
  }
  if (failed > 0) {
    console.log(`\nMismatches (${failed}):`);
    const grouped = new Map<string, Result[]>();
    for (const m of mismatches) {
      const arr = grouped.get(m.rule) ?? [];
      arr.push(m);
      grouped.set(m.rule, arr);
    }
    for (const k of rules) {
      const ms = grouped.get(k) ?? [];
      if (ms.length === 0) continue;
      console.log(`  == ${k} ==`);
      for (const m of ms) {
        console.log(`    - ${m.test}`);
        if (m.reason) {
          console.log(`      ${m.reason.length > 200 ? m.reason.slice(0, 200) + "..." : m.reason}`);
        }
      }
    }
    process.exit(1);
  }
}

main();

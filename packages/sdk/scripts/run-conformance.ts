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
import { spawn } from "node:child_process";
import {
  validateDocument,
  isHigherMajorOrPre1MinorThanMaxTested,
  isLowerThanMinSupported,
  isSupportedVersion,
  MAX_TESTED_VERSION,
  MIN_SUPPORTED_VERSION,
  resolveOperation,
  concludeVerification,
} from "../src/index.js";
import { compileOperationSchema } from "../src/schema-validation.js";
import type { OBInterface } from "../src/types.js";
import type { RuleEvidenceStatus } from "../src/verification.js";

interface FixtureTest {
  description: string;
  document?: unknown;
  documentText?: string;
  documentBase64?: string;
  valid: boolean;
  violates?: string[];
  requiresSupports?: string;
  requiresMaxTested?: string;
  requiresMinSupported?: string;
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

interface ToolScenarioFile {
  rule: string;
  scenarios: Array<{
    id: string;
    description: string;
    action: string;
    given: Record<string, unknown>;
    expected: Record<string, unknown>;
  }>;
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

function listScenarioFiles(root: string): string[] {
  const dir = join(root, "scenarios");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => join(dir, entry))
    .sort();
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
  if (t.requiresSupports !== undefined) {
    // Administer this test only to tools whose OBI-T-04 version-acceptance
    // predicate accepts the annotated version; otherwise skip, reported
    // separately (skips are never failures). For this SDK the predicate is
    // isSupportedVersion — acceptance, not tested-range membership. It never
    // throws (a malformed annotation is simply not accepted), so no
    // fall-through guard is needed.
    if (!isSupportedVersion(t.requiresSupports)) {
      return {
        rule,
        test: t.description,
        passed: false,
        skipped: true,
        expected: t.valid,
        actual: false,
        reason: `requires a tool accepting version ${t.requiresSupports}; this SDK's supported range is ${MIN_SUPPORTED_VERSION}..${MAX_TESTED_VERSION}`,
      };
    }
  }
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
  if (t.requiresMinSupported) {
    // Downward-refusal tests apply only when the SDK's minimum supported
    // version is at or above the annotation's value.
    try {
      if (
        !isLowerThanMinSupported(t.requiresMinSupported) &&
        t.requiresMinSupported !== MIN_SUPPORTED_VERSION
      ) {
        return {
          rule,
          test: t.description,
          passed: false,
          skipped: true,
          expected: t.valid,
          actual: false,
          reason: `requires SDK MinSupported >= ${t.requiresMinSupported}; current is ${MIN_SUPPORTED_VERSION}`,
        };
      }
    } catch {
      // fall through and run normally
    }
  }
  let actual = false;
  let reason: string | undefined;
  try {
    let input: string | Uint8Array;
    if (t.documentText !== undefined) {
      input = t.documentText;
    } else if (t.documentBase64 !== undefined) {
      input = Uint8Array.from(Buffer.from(t.documentBase64, "base64"));
    } else if (Object.hasOwn(t, "document")) {
      input = JSON.stringify(t.document);
    } else {
      throw new Error("fixture supplies no document carriage");
    }
    validateDocument(input);
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

function passScenario(rule: string, test: string): Result {
  return { rule, test, passed: true, skipped: false, expected: true, actual: true };
}

function failScenario(rule: string, test: string, reason: string): Result {
  return { rule, test, passed: false, skipped: false, expected: true, actual: false, reason };
}

function evaluateSchemaCycle(
  scenario: ToolScenarioFile["scenarios"][number],
): string {
  const document = validateDocument(JSON.stringify(scenario.given.document)) as OBInterface;
  const operationName = String(scenario.given.operation);
  const resolved = resolveOperation(document, operationName);
  if (!resolved) throw new Error(`operation ${JSON.stringify(operationName)} not found`);
  const side = String(scenario.given.side);
  const schema = side === "output" ? resolved.operation.output : resolved.operation.input;
  if (schema === undefined) throw new Error(`operation ${side} side has no schema`);
  try {
    const validator = compileOperationSchema(document, resolved.key, side === "output" ? "output" : "input");
    return validator.validate(scenario.given.value).valid ? "valid" : "instance-mismatch";
  } catch {
    return "resolver-error";
  }
}

async function evaluateSchemaCycleWithTimeout(
  scenario: ToolScenarioFile["scenarios"][number],
): Promise<string> {
  const child = spawn(
    process.execPath,
    [...process.execArgv, fileURLToPath(import.meta.url), "--schema-cycle-worker"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.end(JSON.stringify(scenario));
  return await new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("schema-cycle resolution did not terminate within 2 seconds"));
    }, 2_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `schema-cycle worker exited with code ${code}`));
        return;
      }
      try {
        const message = JSON.parse(stdout) as { outcome?: string; error?: string };
        if (message.error) reject(new Error(message.error));
        else resolve(String(message.outcome));
      } catch (error) {
        reject(new Error(`invalid schema-cycle worker response: ${(error as Error).message}`));
      }
    });
  });
}

async function runToolScenario(
  rule: string,
  scenario: ToolScenarioFile["scenarios"][number],
): Promise<Result> {
  try {
    if (scenario.action === "resolve-operation") {
      const document = validateDocument(JSON.stringify(scenario.given.document));
      const name = String(scenario.given.name);
      const resolved = resolveOperation(document, name);
      if (scenario.expected.outcome === "not-found") {
        return resolved === undefined
          ? passScenario(rule, scenario.description)
          : failScenario(rule, scenario.description, `resolved to ${JSON.stringify(resolved.key)}; expected not-found`);
      }
      const expectedKey = String(scenario.expected.operationKey);
      if (!resolved) {
        return failScenario(rule, scenario.description, `not found; expected ${JSON.stringify(expectedKey)}`);
      }
      if (resolved.key !== expectedKey) {
        return failScenario(rule, scenario.description, `resolved key ${JSON.stringify(resolved.key)}; expected ${JSON.stringify(expectedKey)}`);
      }
      const bindingKeys = Object.entries(document.bindings ?? {})
        .filter(([, binding]) => binding.operation === resolved.key)
        .map(([key]) => key)
        .sort();
      const expectedBindings = [...(scenario.expected.bindingKeys as string[])].sort();
      if (JSON.stringify(bindingKeys) !== JSON.stringify(expectedBindings)) {
        return failScenario(rule, scenario.description, `binding keys ${JSON.stringify(bindingKeys)}; expected ${JSON.stringify(expectedBindings)}`);
      }
      return passScenario(rule, scenario.description);
    }

    if (scenario.action === "resolve-schema-cycle") {
      const allowed = scenario.expected.allowedOutcomes as string[];
      const outcome = await evaluateSchemaCycleWithTimeout(scenario);
      return allowed.includes(outcome)
        ? passScenario(rule, scenario.description)
        : failScenario(rule, scenario.description, `outcome ${JSON.stringify(outcome)} not in permitted set ${JSON.stringify(allowed)}`);
    }

    if (scenario.action === "validate-operation-values") {
      const document = validateDocument(JSON.stringify(scenario.given.document)) as OBInterface;
      const operationName = String(scenario.given.operation);
      const resolved = resolveOperation(document, operationName);
      if (!resolved) {
        return failScenario(rule, scenario.description, `operation ${JSON.stringify(operationName)} not found`);
      }
      const side = String(scenario.given.side);
      const schema = side === "output" ? resolved.operation.output : resolved.operation.input;
      if (schema === undefined) {
        return failScenario(rule, scenario.description, `operation ${side} side has no schema`);
      }
      const values = scenario.given.values as unknown[];
      let actual: string[];
      try {
        const validator = compileOperationSchema(document, resolved.key, side === "output" ? "output" : "input");
        actual = values.map((value) =>
          validator.validate(value).valid ? "valid" : "instance-mismatch",
        );
      } catch {
        actual = values.map(() => "graph-unavailable");
      }
      const expected = scenario.expected.results as string[];
      return JSON.stringify(actual) === JSON.stringify(expected)
        ? passScenario(rule, scenario.description)
        : failScenario(rule, scenario.description, `results ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`);
    }

    if (scenario.action === "conclude-verification") {
      const report = concludeVerification(
        scenario.given.evidence as Record<string, RuleEvidenceStatus>,
      );
      const expectedViolated = [...(scenario.expected.violated as string[])].sort();
      const expectedUnverified = [...(scenario.expected.unverified as string[])].sort();
      if (report.conclusion !== scenario.expected.conclusion) {
        return failScenario(rule, scenario.description, `conclusion ${JSON.stringify(report.conclusion)}; expected ${JSON.stringify(scenario.expected.conclusion)}`);
      }
      if (JSON.stringify(report.violated) !== JSON.stringify(expectedViolated)) {
        return failScenario(rule, scenario.description, `violated rules ${JSON.stringify(report.violated)}; expected ${JSON.stringify(expectedViolated)}`);
      }
      if (JSON.stringify(report.unverified) !== JSON.stringify(expectedUnverified)) {
        return failScenario(rule, scenario.description, `unverified rules ${JSON.stringify(report.unverified)}; expected ${JSON.stringify(expectedUnverified)}`);
      }
      return passScenario(rule, scenario.description);
    }

    return failScenario(rule, scenario.description, `unsupported action ${JSON.stringify(scenario.action)}`);
  } catch (error) {
    return failScenario(rule, scenario.description, (error as Error).message);
  }
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let files = listFixtures(args.corpusDir);
  let scenarioFiles = listScenarioFiles(args.corpusDir);
  if (args.ruleFilter) {
    files = files.filter((f) => basename(f, ".json") === args.ruleFilter);
    scenarioFiles = scenarioFiles.filter((f) => basename(f, ".json") === args.ruleFilter);
  }
  if (files.length === 0 && scenarioFiles.length === 0) {
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
  for (const f of scenarioFiles) {
    const data = readFileSync(f, "utf8");
    const file = JSON.parse(data) as ToolScenarioFile;
    for (const scenario of file.scenarios) {
      results.push(await runToolScenario(file.rule, scenario));
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

if (process.argv.includes("--schema-cycle-worker")) {
  try {
    const scenario = JSON.parse(readFileSync(0, "utf8")) as ToolScenarioFile["scenarios"][number];
    process.stdout.write(JSON.stringify({ outcome: evaluateSchemaCycle(scenario) }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: (error as Error).message }));
  }
} else {
  void main().catch((error) => {
    console.error((error as Error).stack ?? String(error));
    process.exit(1);
  });
}

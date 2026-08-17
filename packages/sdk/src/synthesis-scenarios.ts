import type {
  SynthesisCoverageEntry,
  SynthesizeResult,
  SynthesizeSource,
} from "./invoker-types.js";
import { checkAssertions, type ProcessorAssertion } from "./processor-scenarios.js";
import type { OBInterface } from "./types.js";

/**
 * The exact portable synthesis-scenario format this runner implements. A file
 * naming any other revision is refused rather than run: a runner that silently
 * skips what it does not understand reports green having verified none of it.
 */
export const SYNTHESIS_SCENARIO_FORMAT = "openbindings.binding-spec-synthesis-scenarios@3";

export interface SynthesisScenarioFile {
  format: typeof SYNTHESIS_SCENARIO_FORMAT;
  bindingSpec: string;
  family: string;
  description: string;
  scenarios: SynthesisScenario[];
}

export interface SynthesisScenario {
  id: string;
  description: string;
  source: SynthesizeSource;
  /**
   * Closed, immutable companion-document set keyed by absolute retrieval URI,
   * served offline through the family adapter's ordinary artifact resolver.
   * Harness input only: it adds no comparison semantics.
   */
  resources?: Record<string, unknown>;
  expected: SynthesisScenarioExpected;
}

/**
 * Parses one family scenario file, refusing an unrecognized format at runtime.
 * The compile-time literal type is erased, so this is the only thing standing
 * between a runner and a corpus revision it does not implement.
 */
export function parseSynthesisScenarioFile(raw: unknown, family: string): SynthesisScenarioFile {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${family}: malformed synthesis family file`);
  }
  const file = raw as Partial<SynthesisScenarioFile>;
  if (file.format !== SYNTHESIS_SCENARIO_FORMAT) {
    throw new Error(
      `${family}: unsupported synthesis scenario format ${JSON.stringify(file.format)}`,
    );
  }
  if (file.family !== family || !Array.isArray(file.scenarios) || file.scenarios.length === 0) {
    throw new Error(`${family}: malformed synthesis family file`);
  }
  return file as SynthesisScenarioFile;
}

export type SynthesisScenarioExpected = SynthesizedScenarioExpected | RefusedScenarioExpected;

export interface SynthesizedScenarioExpected extends NormalizedSynthesis {
  outcome: "synthesized";
  /**
   * Pointer-addressed assertions evaluated against the emitted OBI document.
   * Each pins exactly the fact its finding is about; a path may traverse only
   * names an authority defines or the artifact itself supplies.
   */
  assertions?: ProcessorAssertion[];
}

export interface RefusedScenarioExpected {
  outcome: "refused";
  /** Governing corpus authority; error type and diagnostic prose are non-portable. */
  rules: string[];
}

export interface NormalizedSynthesis {
  operations: string[];
  bindings: SynthesisBindingIdentity[];
  coverage: {
    exhaustive: boolean;
    fullyRepresented: boolean;
    entries: NormalizedSynthesisCoverageEntry[];
  };
}

export interface SynthesisBindingIdentity {
  operationKey: string;
  bindingRef: string;
}

export interface NormalizedSynthesisCoverageEntry {
  sourceIndex: number;
  sourceRef: string;
  scope: SynthesisCoverageEntry["scope"];
  status: SynthesisCoverageEntry["status"];
  operationKey?: string;
  bindingRef?: string;
  reasonCode?: string;
  rule?: string;
  requirements: string[];
}

export function matchSynthesisScenario(
  scenario: SynthesisScenario,
  result: SynthesizeResult,
): void {
  if (scenario.expected.outcome !== "synthesized") {
    throw new Error(`${scenario.id} expected whole-source refusal but synthesis succeeded`);
  }
  if (scenario.expected.assertions !== undefined) {
    try {
      checkAssertions(
        JSON.parse(JSON.stringify(result.interface)) as unknown,
        scenario.expected.assertions,
      );
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${scenario.id} emitted-document assertion failed: ${detail}`, { cause: error });
    }
  }
  const got = normalizeSynthesis(result);
  const want = normalizeExpected(scenario.expected);
  if (canonicalJSON(got) !== canonicalJSON(want)) {
    throw new Error(
      `${scenario.id} synthesis mismatch\n`
      + `got:\n${JSON.stringify(got, undefined, 2)}\n`
      + `want:\n${JSON.stringify(want, undefined, 2)}`,
    );
  }
}

/**
 * Executes a portable synthesis scenario without making thrown error shape
 * part of the shared contract. A refused scenario requires any loud failure;
 * a synthesized scenario compares the normalized successful boundary.
 */
export async function verifySynthesisScenario(
  scenario: SynthesisScenario,
  synthesize: () => Promise<SynthesizeResult>,
): Promise<void> {
  let result: SynthesizeResult;
  try {
    result = await synthesize();
  } catch (error: unknown) {
    if (scenario.expected.outcome === "refused") return;
    throw error;
  }
  matchSynthesisScenario(scenario, result);
}

export function normalizeSynthesis(result: SynthesizeResult): NormalizedSynthesis {
  return {
    operations: Object.keys(result.interface.operations).sort(codePointCompare),
    bindings: normalizeBindings(result.interface),
    coverage: {
      exhaustive: result.coverage.exhaustive,
      fullyRepresented: result.coverage.fullyRepresented,
      entries: result.coverage.entries.map(normalizeCoverageEntry).sort(compareCoverage),
    },
  };
}

function normalizeExpected(expected: NormalizedSynthesis): NormalizedSynthesis {
  return {
    operations: [...expected.operations].sort(codePointCompare),
    bindings: [...expected.bindings].sort(compareBindings),
    coverage: {
      exhaustive: expected.coverage.exhaustive,
      fullyRepresented: expected.coverage.fullyRepresented,
      entries: expected.coverage.entries.map((entry) => ({
        ...entry,
        requirements: [...entry.requirements].sort(codePointCompare),
      })).sort(compareCoverage),
    },
  };
}

function normalizeBindings(iface: OBInterface): SynthesisBindingIdentity[] {
  return Object.values(iface.bindings ?? {})
    .map((binding) => ({
      operationKey: binding.operation,
      bindingRef: binding.ref ?? "",
    }))
    .sort(compareBindings);
}

function normalizeCoverageEntry(entry: SynthesisCoverageEntry): NormalizedSynthesisCoverageEntry {
  const normalized: NormalizedSynthesisCoverageEntry = {
    sourceIndex: entry.sourceIndex,
    sourceRef: entry.sourceRef,
    scope: entry.scope,
    status: entry.status,
    requirements: [...(entry.requirements ?? [])].sort(codePointCompare),
  };
  if (entry.operationKey !== undefined) normalized.operationKey = entry.operationKey;
  if (entry.bindingRef !== undefined) normalized.bindingRef = entry.bindingRef;
  if (entry.reasonCode !== undefined) normalized.reasonCode = entry.reasonCode;
  if (entry.rule !== undefined) normalized.rule = entry.rule;
  return normalized;
}

function compareBindings(a: SynthesisBindingIdentity, b: SynthesisBindingIdentity): number {
  return codePointCompare(a.operationKey, b.operationKey)
    || codePointCompare(a.bindingRef, b.bindingRef);
}

function compareCoverage(
  a: NormalizedSynthesisCoverageEntry,
  b: NormalizedSynthesisCoverageEntry,
): number {
  return a.sourceIndex - b.sourceIndex
    || codePointCompare(a.scope, b.scope)
    || codePointCompare(a.sourceRef, b.sourceRef);
}

function codePointCompare(a: string, b: string): number {
  const aa = [...a];
  const bb = [...b];
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
    const delta = aa[i]!.codePointAt(0)! - bb[i]!.codePointAt(0)!;
    if (delta !== 0) return delta;
  }
  return aa.length - bb.length;
}

function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortJSON(value));
}

function sortJSON(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJSON);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort(codePointCompare).map((key) => [key, sortJSON(record[key])]),
    );
  }
  return value;
}

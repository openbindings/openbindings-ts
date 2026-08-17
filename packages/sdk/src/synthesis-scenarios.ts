import type {
  SynthesisCoverageEntry,
  SynthesizeResult,
  SynthesizeSource,
} from "./invoker-types.js";
import type { OBInterface } from "./types.js";

export interface SynthesisScenarioFile {
  format: "openbindings.binding-spec-synthesis-scenarios@2";
  bindingSpec: string;
  family: string;
  description: string;
  scenarios: SynthesisScenario[];
}

export interface SynthesisScenario {
  id: string;
  description: string;
  source: SynthesizeSource;
  expected: SynthesisScenarioExpected;
}

export type SynthesisScenarioExpected = SynthesizedScenarioExpected | RefusedScenarioExpected;

export interface SynthesizedScenarioExpected extends NormalizedSynthesis {
  outcome: "synthesized";
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

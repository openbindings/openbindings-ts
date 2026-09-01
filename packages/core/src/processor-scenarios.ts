/**
 * Language-neutral primitives for executing the portable binding-specification
 * processor corpus. Family packages translate a scenario into their idiomatic
 * public API and return one normalized observation; this module owns matching
 * so every TypeScript adapter judges the same contract as the Go runner.
 */

export interface ProcessorScenarioFile {
  format:
    | "openbindings.binding-spec-processor-scenarios@1"
    // Revision 3 only ADDS the `notContains` assertion to revision 2, so a
    // revision-3 reader interprets a revision-2 file exactly as a revision-2
    // reader would. Accepting both keeps the corpus and the engines free to
    // merge in either order instead of in lockstep.
    | "openbindings.binding-spec-processor-scenarios@2"
    | "openbindings.binding-spec-processor-scenarios@3"
    | "openbindings.invocation-fidelity-scenarios@1";
  bindingSpec: string;
  family: string;
  description: string;
  scenarios: ProcessorScenario[];
}

export interface ProcessorScenario {
  id: string;
  rules: string[];
  section: string;
  description: string;
  given: {
    source: Record<string, unknown>;
    binding: Record<string, unknown>;
    configuration?: Record<string, unknown>;
    invocation: Record<string, unknown> & { inputPresent: boolean };
    peer?: Record<string, unknown>;
    runtime?: Record<string, unknown>;
    /** Closed artifact dependency set supplied to a family adapter's resolver. */
    resources?: Record<string, unknown>;
  };
  expected: ProcessorExpected[];
}

export interface ProcessorExpected {
  disposition: ProcessorDisposition;
  phase: ProcessorPhase;
  description?: string;
  assertions: ProcessorAssertion[];
}

export type ProcessorDisposition = "complete" | "error" | "refusal" | "context-required";
export type ProcessorPhase =
  | "load"
  | "resolution"
  | "pre-dispatch"
  | "dispatch"
  | "response"
  | "completion";

export interface ProcessorAssertion {
  path: string;
  equals?: unknown;
  absent?: true;
  oneOf?: unknown[];
  setEquals?: unknown[];
  contains?: unknown;
  /**
   * Pins the ABSENCE of a substring or member: a header never emitted, a
   * field never serialized. Corpus revision 3.
   */
  notContains?: unknown;
}

export interface ProcessorObservation {
  disposition: ProcessorDisposition;
  phase: ProcessorPhase;
  data: Record<string, unknown>;
}

export interface ProcessorMatch {
  /** Zero-based index in the scenario's unordered permitted alternatives. */
  alternative: number;
}

/**
 * Matches a normalized observation against the scenario's unordered permitted
 * alternatives. Throws a diagnostic containing every alternative failure.
 */
export function matchProcessorObservation(
  scenario: ProcessorScenario,
  observation: ProcessorObservation,
): ProcessorMatch {
  const failures: string[] = [];
  for (const [index, expected] of scenario.expected.entries()) {
    try {
      matchAlternative(expected, observation);
      return { alternative: index };
    } catch (error: unknown) {
      failures.push(`alternative ${index + 1}: ${errorMessage(error)}`);
    }
  }
  throw new Error(`${scenario.id} matched no permitted alternative:\n${failures.join("\n")}`);
}

function matchAlternative(expected: ProcessorExpected, got: ProcessorObservation): void {
  if (got.disposition !== expected.disposition) {
    throw new Error(`disposition = ${quoted(got.disposition)}, want ${quoted(expected.disposition)}`);
  }
  if (got.phase !== expected.phase) {
    throw new Error(`phase = ${quoted(got.phase)}, want ${quoted(expected.phase)}`);
  }
  checkAssertions(got.data, expected.assertions);
}

/**
 * Applies every assertion to one JSON-shaped root value. Exported so the other
 * portable-corpus runners in this package evaluate the shared assertion
 * vocabulary through this evaluator instead of reimplementing it: the synthesis
 * corpus addresses an emitted OBI document with the same five verbs this corpus
 * addresses a normalized observation with.
 */
export function checkAssertions(root: unknown, assertions: ProcessorAssertion[]): void {
  for (const assertion of assertions) {
    const selected = selectPointer(root, assertion.path);
    if (assertion.absent === true) {
      if (selected.present) {
        throw new Error(`${assertion.path} is present (${printable(selected.value)}), want absent`);
      }
      continue;
    }
    if (!selected.present) throw new Error(`${assertion.path} is absent`);

    if (Object.prototype.hasOwnProperty.call(assertion, "equals")) {
      if (!jsonEqual(selected.value, assertion.equals)) {
        throw new Error(
          `${assertion.path} = ${printable(selected.value)}, want ${printable(assertion.equals)}`,
        );
      }
    } else if (assertion.oneOf !== undefined) {
      if (!assertion.oneOf.some((candidate) => jsonEqual(selected.value, candidate))) {
        throw new Error(
          `${assertion.path} = ${printable(selected.value)}, want one of ${printable(assertion.oneOf)}`,
        );
      }
    } else if (assertion.setEquals !== undefined) {
      if (!setEqual(selected.value, assertion.setEquals)) {
        throw new Error(
          `${assertion.path} = ${printable(selected.value)}, want set ${printable(assertion.setEquals)}`,
        );
      }
    } else if (Object.prototype.hasOwnProperty.call(assertion, "contains")) {
      if (!contains(selected.value, assertion.contains)) {
        throw new Error(
          `${assertion.path} = ${printable(selected.value)}, want to contain ${printable(assertion.contains)}`,
        );
      }
    } else if (Object.prototype.hasOwnProperty.call(assertion, "notContains")) {
      if (contains(selected.value, assertion.notContains)) {
        throw new Error(
          `${assertion.path} = ${printable(selected.value)}, want NOT to contain ${printable(assertion.notContains)}`,
        );
      }
    } else {
      throw new Error(`${assertion.path} has no comparison operator`);
    }
  }
}

function selectPointer(root: unknown, pointer: string): { present: boolean; value?: unknown } {
  if (pointer === "") return { present: true, value: root };
  if (!pointer.startsWith("/")) throw new Error(`invalid JSON Pointer ${quoted(pointer)}`);
  let current: unknown = root;
  for (const raw of pointer.slice(1).split("/")) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return { present: false };
      const index = Number(segment);
      if (index >= current.length) return { present: false };
      current = current[index];
    } else if (isRecord(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return { present: false };
      current = current[segment];
    } else {
      return { present: false };
    }
  }
  return { present: true, value: current };
}

function setEqual(actual: unknown, expected: unknown[]): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const used = new Set<number>();
  for (const wanted of expected) {
    const index = actual.findIndex((value, i) => !used.has(i) && jsonEqual(value, wanted));
    if (index < 0) return false;
    used.add(index);
  }
  return true;
}

function contains(actual: unknown, needle: unknown): boolean {
  if (typeof actual === "string" && typeof needle === "string") return actual.includes(needle);
  if (Array.isArray(actual)) return actual.some((value) => jsonEqual(value, needle));
  if (isRecord(actual) && typeof needle === "string") {
    return Object.prototype.hasOwnProperty.call(actual, needle);
  }
  return false;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return canonicalJSON(a) === canonicalJSON(b);
}

function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortJSON(value));
}

function sortJSON(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJSON);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJSON(value[key])]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function printable(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import type { OBInterface, Operation } from "@openbindings/core";
import { MAX_TESTED_VERSION, validateInterface } from "@openbindings/core";

/** Describes a binding source for interface synthesis. */
export interface SynthesizeSource {
  bindingSpec: string;
  name?: string;
  location?: string;
  content?: unknown;
  outputLocation?: string;
  embed?: boolean;
  description?: string;
}

/** Input for synthesizing an OpenBindings interface from binding-spec-specific sources. */
export interface SynthesizeInput {
  openbindingsVersion?: string;
  sources?: SynthesizeSource[];
  name?: string;
  version?: string;
  description?: string;
  /**
   * Invoked for a non-fatal, usable but lossy schema projection. A warning
   * must never stand in for omitting a callable target or returning an
   * operation that is statically guaranteed to refuse; those conditions fail
   * synthesis. Undefined is safe because the returned interface remains
   * sound. Mirrors the Go SDK's SynthesizeInput.OnWarning.
   */
  onWarning?: (warning: SynthesizerWarning) => void;
}

/** Deterministic source-less result required by the interface-synthesizer contract. */
export function synthesisSkeleton(input: SynthesizeInput = {}): OBInterface {
  const iface: OBInterface = {
    openbindings: input.openbindingsVersion ?? MAX_TESTED_VERSION,
    ...(input.name ? { name: input.name } : {}),
    ...(input.version ? { version: input.version } : {}),
    ...(input.description ? { description: input.description } : {}),
    operations: {},
  };
  validateInterface(iface);
  return iface;
}

/** Applies the format-neutral single-source authoring directives and validates the emitted OBI. */
export function finalizeSynthesis(
  iface: OBInterface,
  input: SynthesizeInput,
  defaultSourceName: string,
  bindingSpec: string,
): OBInterface {
  const [source] = input.sources ?? [];
  if (!source || (input.sources?.length ?? 0) !== 1) {
    throw new Error("finalize synthesis requires one source and one interface");
  }
  if (source.bindingSpec !== bindingSpec) {
    throw new Error(`synthesizer supports exact binding specification ${JSON.stringify(bindingSpec)}, got ${JSON.stringify(source.bindingSpec)}`);
  }
  if (input.openbindingsVersion) iface.openbindings = input.openbindingsVersion;
  if (input.name) iface.name = input.name;
  if (input.version) iface.version = input.version;
  if (input.description) iface.description = input.description;

  const entry = iface.sources?.[defaultSourceName];
  if (!entry) throw new Error(`synthesizer emitted no source ${JSON.stringify(defaultSourceName)}`);
  entry.bindingSpec = bindingSpec;
  if (source.outputLocation) entry.location = source.outputLocation;
  if (source.description) entry.description = source.description;
  const outputName = source.name || defaultSourceName;
  if (outputName !== defaultSourceName) {
    delete iface.sources![defaultSourceName];
    iface.sources![outputName] = entry;
    for (const binding of Object.values(iface.bindings ?? {})) {
      if (binding.source === defaultSourceName) binding.source = outputName;
    }
  }
  validateInterface(iface);
  return iface;
}

/**
 * A non-fatal, usable but lossy projection made while building an interface
 * from a source. Every returned operation remains bindable. Codes are stable
 * and binding-family-namespaced; `path` locates the affected member in dotted
 * notation. Mirrors the Go SDK's SynthesizerWarning.
 */
export interface SynthesizerWarning {
  code: string;
  message: string;
  path?: string;
  details?: Record<string, unknown>;
}

/** Granularity of one synthesis coverage entry. */
export type SynthesisCoverageScope = "target" | "alternative" | "projection" | "dependency";

/** Durable disposition of one source interaction unit. */
export type SynthesisCoverageStatus =
  | "represented"
  | "excluded"
  | "invalid"
  | "lossy"
  | "implementation-unsupported";

/**
 * Disposition of one addressable target or independently selectable source
 * alternative observed by the same call that produced the synthesized OBI.
 */
export interface SynthesisCoverageEntry {
  /** Zero-based index of the input source containing this interaction unit. */
  sourceIndex: number;
  /** Emitted source key; required for represented and lossy binding-backed entries. */
  sourceKey?: string;
  /** Stable source-local identifier; need not be a conformant binding selector. */
  sourceRef: string;
  scope: SynthesisCoverageScope;
  status: SynthesisCoverageStatus;
  /** Required for represented and lossy binding-backed entries. */
  operationKey?: string;
  /** Emitted binding key; required for represented and lossy entries. */
  bindingKey?: string;
  /** Required for represented and lossy binding-backed entries; empty denotes an omitted selector. */
  bindingSelector?: string;
  /** Stable family-namespaced code; required for non-represented entries. */
  reasonCode?: string;
  /** Governing binding-specification rule or section, when applicable. */
  rule?: string;
  /** Human-readable explanation; required for non-represented entries. */
  message?: string;
  /** Named runtime prerequisites that do not make a represented unit partial. */
  requirements?: string[];
  /** Family-specific structured evidence. */
  details?: Record<string, unknown>;
}

/** Durable coverage evidence for one synthesis observation. */
export interface SynthesisCoverage {
  entries: SynthesisCoverageEntry[];
  /** True only when the governing family inventory is completely accounted for. */
  exhaustive: boolean;
  /**
   * Derived: exhaustive and every inventoried unit is represented. Any
   * non-represented entry — lossy, excluded, invalid, or
   * implementation-unsupported — clears it: a document with an invalid unit
   * is accounted, never reported as fully represented.
   */
  fullyRepresented: boolean;
  /** Explains what may be missing when exhaustive is false. */
  limitation?: SynthesisCoverageLimitation;
}

/** Machine-readable evidence for a non-exhaustive synthesis inventory. */
export interface SynthesisCoverageLimitation {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** A creation-time-sound OBI and coverage evidence from the same observation. */
export interface SynthesizeResult {
  interface: OBInterface;
  coverage: SynthesisCoverage;
}

const SYNTHESIS_REASON_CODE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;

/**
 * Validates durable coverage evidence against an emitted OBI and derives
 * fullyRepresented. Binding-family synthesizers call this after
 * finalizeSynthesis at the same observation boundary.
 */
export function finalizeSynthesisCoverage(
  iface: OBInterface,
  entries: SynthesisCoverageEntry[],
  exhaustive: boolean,
  limitation: SynthesisCoverageLimitation | undefined = exhaustive
    ? undefined
    : {
        code: "synthesis.inventory_incomplete",
        message: "the implementation could not establish that its source interaction inventory was exhaustive",
      },
  options?: {
    /**
     * Set false when the SAME interface value was already validated at this
     * observation boundary (finalizeSynthesis) — interface validation over a
     * large document is the dominant synthesis cost, and validating an
     * unchanged value twice buys nothing. Coverage-entry validation always
     * runs.
     */
    revalidateInterface?: boolean;
  },
): SynthesizeResult {
  if (options?.revalidateInterface !== false) validateInterface(iface);
  if (exhaustive && limitation) {
    throw new Error("exhaustive synthesis coverage must not carry a limitation");
  }
  if (!exhaustive) {
    if (!limitation) {
      throw new Error("non-exhaustive synthesis coverage requires a limitation");
    }
    if (!SYNTHESIS_REASON_CODE.test(limitation.code) || !limitation.message) {
      throw new Error("synthesis coverage limitation requires a valid code and message");
    }
  }
  const normalizedEntries = entries.map((entry) => ({ ...entry }));
  const seen = new Set<string>();
  let fullyRepresented = exhaustive;

  for (const [index, entry] of normalizedEntries.entries()) {
    if (!Number.isInteger(entry.sourceIndex) || entry.sourceIndex < 0) {
      throw new Error(`synthesis coverage entry ${index} has invalid sourceIndex`);
    }
    if (!entry.sourceRef) {
      throw new Error(`synthesis coverage entry ${index} has empty sourceRef`);
    }
    if (
      entry.scope !== "target"
      && entry.scope !== "alternative"
      && entry.scope !== "projection"
      && entry.scope !== "dependency"
    ) {
      throw new Error(`synthesis coverage entry ${index} has invalid scope`);
    }
    const key = `${entry.sourceIndex}\0${entry.scope}\0${entry.sourceRef}`;
    if (seen.has(key)) {
      throw new Error(`duplicate synthesis coverage entry for source ${entry.sourceIndex} ${entry.scope} ${JSON.stringify(entry.sourceRef)}`);
    }
    seen.add(key);

    const requirements = new Set<string>();
    for (const requirement of entry.requirements ?? []) {
      if (!requirement) throw new Error(`synthesis coverage entry ${index} has an empty requirement`);
      if (requirements.has(requirement)) {
        throw new Error(`synthesis coverage entry ${index} repeats requirement ${JSON.stringify(requirement)}`);
      }
      requirements.add(requirement);
    }

    if (entry.scope === "dependency" && entry.status === "represented") {
      if (entry.reasonCode) {
        throw new Error(`represented synthesis coverage entry ${index} must not carry reasonCode`);
      }
      continue;
    }

    if (entry.status === "represented" || entry.status === "lossy") {
      if (!entry.operationKey || entry.bindingSelector === undefined) {
        throw new Error(`${entry.status} synthesis coverage entry ${index} requires operationKey and bindingSelector`);
      }
      if (entry.status === "represented" && entry.reasonCode) {
        throw new Error(`represented synthesis coverage entry ${index} must not carry reasonCode`);
      }
      if (!Object.hasOwn(iface.operations, entry.operationKey)) {
        throw new Error(`${entry.status} synthesis coverage entry ${index} names missing operation ${JSON.stringify(entry.operationKey)}`);
      }
      if (!entry.bindingKey) {
        const matches = Object.entries(iface.bindings ?? {}).filter(
          ([, binding]) =>
            binding.operation === entry.operationKey
            && (binding.selector ?? "") === entry.bindingSelector,
        );
        if (matches.length > 1) {
          throw new Error(`${entry.status} synthesis coverage entry ${index} matches several bindings; bindingKey is required to disambiguate`);
        }
        entry.bindingKey = matches[0]?.[0];
      }
      const matchingBinding = entry.bindingKey
        ? iface.bindings?.[entry.bindingKey]
        : undefined;
      if (
        !matchingBinding
        || matchingBinding.operation !== entry.operationKey
        || (matchingBinding.selector ?? "") !== entry.bindingSelector
      ) {
        throw new Error(`${entry.status} synthesis coverage entry ${index} has no matching binding for operation ${JSON.stringify(entry.operationKey)} and selector ${JSON.stringify(entry.bindingSelector)}`);
      }
      entry.sourceKey ??= matchingBinding.source;
      if (matchingBinding.source !== entry.sourceKey) {
        throw new Error(`${entry.status} synthesis coverage entry ${index} binding ${JSON.stringify(entry.bindingKey)} uses source ${JSON.stringify(matchingBinding.source)}, not ${JSON.stringify(entry.sourceKey)}`);
      }
      if (!iface.sources || !Object.hasOwn(iface.sources, entry.sourceKey)) {
        throw new Error(`${entry.status} synthesis coverage entry ${index} names missing source ${JSON.stringify(entry.sourceKey)}`);
      }
      if (entry.status === "represented") continue;
    }

    if (
      entry.status !== "excluded"
      && entry.status !== "invalid"
      && entry.status !== "lossy"
      && entry.status !== "implementation-unsupported"
    ) {
      throw new Error(`synthesis coverage entry ${index} has invalid status`);
    }
    if (!entry.reasonCode || !SYNTHESIS_REASON_CODE.test(entry.reasonCode)) {
      throw new Error(`synthesis coverage entry ${index} has invalid reasonCode ${JSON.stringify(entry.reasonCode)}`);
    }
    if (!entry.message) {
      throw new Error(`synthesis coverage entry ${index} requires a message`);
    }
    // Every non-represented status clears fullyRepresented — invalid
    // included. An upstream-invalid unit is still an inventoried unit the
    // emitted OBI does not represent (MC5 seal-1 finding F-V3-1: a document
    // whose every target was invalid reported fullyRepresented true).
    fullyRepresented = false;
  }

  return {
    interface: iface,
    coverage: {
      entries: normalizedEntries,
      exhaustive,
      fullyRepresented,
      ...(limitation ? { limitation } : {}),
    },
  };
}

/**
 * Produces one represented target entry per emitted binding. A family may use
 * this as exhaustive evidence only after separately proving that its upstream
 * interaction inventory maps one-to-one to bindings.
 */
export function representedCoverageEntries(
  iface: OBInterface,
  sourceIndex: number,
): SynthesisCoverageEntry[] {
  return Object.entries(iface.bindings ?? {})
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([bindingKey, binding]) => ({
      sourceIndex,
      sourceKey: binding.source,
      sourceRef: binding.selector ?? "",
      scope: "target" as const,
      status: "represented" as const,
      operationKey: binding.operation,
      bindingKey,
      bindingSelector: binding.selector ?? "",
    }));
}

/** A target within a source document that can be framed as an OpenBindings operation. */
export interface BindableTarget {
  /** The selector string to use in a binding entry. */
  selector: string;
  /** Optional suggested operation key for this target. */
  operationKey?: string;
  /** Optional OpenBindings operation framing for this target. */
  operation?: Operation;
}

/** Result of inspecting a source document for bindable targets. */
export interface SourceInspection {
  /** The list of bindable targets discovered in the source. */
  targets: BindableTarget[];
  /**
   * True when this is the complete list of targets for the source.
   * When false, additional targets may exist that were not enumerated.
   */
  exhaustive: boolean;
  /** Required when exhaustive is false. */
  limitation?: InspectionLimitation;
}

/** Explains why a source inspection is not exhaustive. */
export interface InspectionLimitation {
  /** Stable namespaced reason code. */
  code: string;
  /** Human-readable explanation of what may be missing and why. */
  message: string;
  details?: Record<string, unknown>;
}

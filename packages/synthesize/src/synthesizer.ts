import type { OBInterface, Source, BindingSpecInfo, BindingSpecVerdict } from "@openbindings/core";
import type {
  SynthesizeInput,
  SynthesizeResult,
  SourceInspection,
} from "./synthesizer-types.js";

/**
 * Synthesizes OpenBindings interfaces from sources governed by its
 * supported binding specifications.
 * Independent of a binding invoker -- an implementation may provide one, the other, or both.
 * Synthesizers load sources fresh on every call; parsed-artifact caching belongs
 * to invokers (authoring wants freshness).
 * Every returned binding must resolve to a supported target and admit at least
 * one faithful invocation path. If an accepted callable target cannot be
 * represented faithfully, synthesis fails rather than returning a silent
 * partial interface.
 */
export interface InterfaceSynthesizer {
  /** Authoritatively checks support for exact, opaque identifiers. */
  checkBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[];
  /** Advisory discoverability metadata; absence is not evidence of non-support. */
  bindingSpecs(): BindingSpecInfo[];
  synthesizeInterface(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<OBInterface>;
}

/**
 * Extends InterfaceSynthesizer with durable accounting of every source
 * interaction unit observed by the same synthesis call. Kept as a separate
 * capability so third-party synthesizers can adopt it without pretending an
 * incomplete report is exhaustive.
 */
export interface CoverageSynthesizer extends InterfaceSynthesizer {
  synthesizeInterfaceWithCoverage(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<SynthesizeResult>;
}

/**
 * Inspects binding source artifacts and returns bindable targets that tooling
 * can frame as OpenBindings operations.
 */
export interface SourceInspector {
  bindingSpecs(): BindingSpecInfo[];
  inspectSource(
    source: Source,
    options?: { signal?: AbortSignal },
  ): Promise<SourceInspection>;
}

/** Type guard that checks whether a binding invoker (or any provider) also implements {@link InterfaceSynthesizer}. */
export function isInterfaceSynthesizer<P extends object>(
  p: P,
): p is P & InterfaceSynthesizer {
  return "synthesizeInterface" in p
    && typeof (p as unknown as Record<string, unknown>)["synthesizeInterface"] === "function";
}

import type { OBInterface, Source, BindingSpecInfo } from "@openbindings/core";
import type { CoverageSynthesizer, InterfaceSynthesizer, SourceInspector } from "./synthesizer.js";
import type {
  SynthesizeInput,
  SynthesizeResult,
  SourceInspection,
} from "./synthesizer-types.js";
import { NoSynthesizerError, SynthesisCoverageUnsupportedError } from "./errors.js";
import { finalizeSynthesisCoverage, synthesisSkeleton } from "./synthesizer-types.js";

/**
 * Returns a single InterfaceSynthesizer that routes to the appropriate inner
 * synthesizer by the source's binding-specification identifier (exact
 * match). First registration wins for a given identifier; order matters.
 */
export type CombinedSynthesizer = CoverageSynthesizer;

export function combineSynthesizers(...synthesizers: InterfaceSynthesizer[]): CombinedSynthesizer {
  const bySpec = new Map<string, InterfaceSynthesizer>(); // exact identifier -> synthesizer
  const specs: BindingSpecInfo[] = [];

  for (const synthesizer of synthesizers) {
    for (const info of synthesizer.bindingSpecs()) {
      if (bySpec.has(info.bindingSpec)) continue; // first registration wins
      bySpec.set(info.bindingSpec, synthesizer);
      specs.push(info);
    }
  }

  return {
    bindingSpecs(): BindingSpecInfo[] {
      return [...specs];
    },
    async synthesizeInterface(
      input: SynthesizeInput,
      options?: { signal?: AbortSignal },
    ): Promise<OBInterface> {
      const [firstSource] = input.sources ?? [];
      if (!firstSource) {
        return synthesisSkeleton(input);
      }
      const synthesizer = bySpec.get(firstSource.bindingSpec);
      if (!synthesizer) throw new NoSynthesizerError(firstSource.bindingSpec);
      return synthesizer.synthesizeInterface(input, options);
    },
    async synthesizeInterfaceWithCoverage(
      input: SynthesizeInput,
      options?: { signal?: AbortSignal },
    ): Promise<SynthesizeResult> {
      const [firstSource] = input.sources ?? [];
      if (!firstSource) {
        return finalizeSynthesisCoverage(synthesisSkeleton(input), [], true);
      }
      const synthesizer = bySpec.get(firstSource.bindingSpec);
      if (!synthesizer) throw new NoSynthesizerError(firstSource.bindingSpec);
      const candidate = synthesizer as Partial<CoverageSynthesizer>;
      if (typeof candidate.synthesizeInterfaceWithCoverage !== "function") {
        throw new SynthesisCoverageUnsupportedError(firstSource.bindingSpec);
      }
      return candidate.synthesizeInterfaceWithCoverage(input, options);
    },
  };
}

/**
 * Returns a single SourceInspector that routes to the appropriate inner
 * inspector by the source's binding-specification identifier (exact match).
 * First registration wins for a given identifier; order matters.
 */
export function combineSourceInspectors(...inspectors: SourceInspector[]): SourceInspector {
  const bySpec = new Map<string, SourceInspector>(); // exact identifier -> inspector
  const specs: BindingSpecInfo[] = [];

  for (const inspector of inspectors) {
    for (const info of inspector.bindingSpecs()) {
      if (bySpec.has(info.bindingSpec)) continue; // first registration wins
      bySpec.set(info.bindingSpec, inspector);
      specs.push(info);
    }
  }

  return {
    bindingSpecs(): BindingSpecInfo[] {
      return [...specs];
    },
    async inspectSource(
      source: Source,
      options?: { signal?: AbortSignal },
    ): Promise<SourceInspection> {
      const inspector = bySpec.get(source.bindingSpec);
      if (!inspector) throw new NoSynthesizerError(source.bindingSpec);
      return inspector.inspectSource(source, options);
    },
  };
}

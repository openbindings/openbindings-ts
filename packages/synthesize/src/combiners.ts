import { checkBindingSpecs as unsupportedVerdicts } from "@openbindings/core";
import type { OBInterface, Source, BindingSpecInfo, BindingSpecVerdict } from "@openbindings/core";
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
  const specs: BindingSpecInfo[] = [];
  const listed = new Set<string>();

  for (const synthesizer of synthesizers) {
    for (const info of synthesizer.bindingSpecs()) {
      if (listed.has(info.bindingSpec)) continue;
      listed.add(info.bindingSpec);
      specs.push(info);
    }
  }

  function supportingSynthesizer(bindingSpec: string): InterfaceSynthesizer | undefined {
    return synthesizers.find((synthesizer) => {
      const verdict = synthesizer.checkBindingSpecs([bindingSpec])[0];
      return verdict?.bindingSpec === bindingSpec && verdict.supported === true;
    });
  }

  return {
    checkBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
      const verdicts = unsupportedVerdicts(bindingSpecs, []);
      const bySpec = new Map(verdicts.map((verdict) => [verdict.bindingSpec, verdict]));
      const requested = verdicts.map(({ bindingSpec }) => bindingSpec);
      for (const synthesizer of synthesizers) {
        for (const verdict of synthesizer.checkBindingSpecs(requested)) {
          const combined = bySpec.get(verdict.bindingSpec);
          if (combined && verdict.supported === true) combined.supported = true;
        }
      }
      return verdicts;
    },
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
      const synthesizer = supportingSynthesizer(firstSource.bindingSpec);
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
      const synthesizer = supportingSynthesizer(firstSource.bindingSpec);
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

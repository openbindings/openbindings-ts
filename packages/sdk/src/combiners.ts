import type { BindingInvoker, InterfaceSynthesizer, SourceInspector } from "./invokers.js";
import type {
  BindingInvocationArgs,
  BindingSpecInfo,
  SynthesizeInput,
  SourceInspection,
} from "./invoker-types.js";
import type { ContextRequiredDetails, Invocation } from "./invocation.js";
import type { OBInterface, Source } from "./types.js";
import { NoInvokerError, NoSynthesizerError, NoSourcesError } from "./errors.js";

/**
 * Returns a single BindingInvoker that routes to the appropriate inner
 * invoker by the source's binding-specification identifier. Identifiers are
 * exact and opaque (core §6): matching is string equality, never
 * version-range interpretation. First registration wins for a given
 * identifier; order matters.
 */
export interface CombinedInvoker extends BindingInvoker {
  /** Register an additional invoker after construction. First registration wins per identifier. */
  add(invoker: BindingInvoker): void;
  /** Always present on the combiner: routes to the inner invoker's preflight, or reports no requirement. */
  prepareBinding(args: BindingInvocationArgs): Promise<ContextRequiredDetails | null>;
}

export function combineInvokers(...invokers: BindingInvoker[]): CombinedInvoker {
  const bySpec = new Map<string, BindingInvoker>(); // exact identifier -> invoker
  const specs: BindingSpecInfo[] = [];

  function register(invoker: BindingInvoker): void {
    for (const info of invoker.bindingSpecs()) {
      if (bySpec.has(info.bindingSpec)) continue; // first registration wins
      bySpec.set(info.bindingSpec, invoker);
      specs.push(info);
    }
  }

  for (const invoker of invokers) {
    register(invoker);
  }

  return {
    add: register,
    bindingSpecs(): BindingSpecInfo[] {
      return [...specs];
    },
    invokeBinding<I, O>(args: BindingInvocationArgs): Invocation<I, O> {
      const invoker = bySpec.get(args.source.bindingSpec);
      // A missing invoker is a wiring error, knowable synchronously: throw
      // rather than returning a pre-errored handle.
      if (!invoker) throw new NoInvokerError(args.source.bindingSpec);
      return invoker.invokeBinding<I, O>(args);
    },
    async prepareBinding(args: BindingInvocationArgs): Promise<ContextRequiredDetails | null> {
      const invoker = bySpec.get(args.source.bindingSpec);
      if (!invoker) throw new NoInvokerError(args.source.bindingSpec);
      // An invoker without preflight support simply reports no requirement.
      return invoker.prepareBinding ? invoker.prepareBinding(args) : null;
    },
  };
}

/**
 * Returns a single InterfaceSynthesizer that routes to the appropriate inner
 * synthesizer by the source's binding-specification identifier (exact
 * match). First registration wins for a given identifier; order matters.
 */
export function combineSynthesizers(...synthesizers: InterfaceSynthesizer[]): InterfaceSynthesizer {
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
      if (!input.sources?.length) throw new NoSourcesError();
      const synthesizer = bySpec.get(input.sources[0].bindingSpec);
      if (!synthesizer) throw new NoSynthesizerError(input.sources[0].bindingSpec);
      return synthesizer.synthesizeInterface(input, options);
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

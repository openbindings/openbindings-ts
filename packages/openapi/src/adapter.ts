import type { BindingSpecInfo, BindingSpecVerdict, OBInterface, Source } from "@openbindings/core";
import type {
  BindingInvoker,
  BindingInvocationArgs,
  ContextRequiredDetails,
  Invocation,
} from "@openbindings/invoke";
import type {
  CoverageSynthesizer,
  SourceInspection,
  SourceInspector,
  SynthesizeInput,
  SynthesizeResult,
} from "@openbindings/synthesize";
import { OpenAPIInvoker, type OpenAPIInvokerOptions } from "./native-invoker.js";
import { OpenAPISynthesizer } from "./synthesizer.js";

/** Coherent configuration for all OpenBindings-facing OpenAPI capabilities. */
export interface OpenAPIAdapterOptions extends OpenAPIInvokerOptions {
  /** Artifact and external-reference retrieval used by synthesis and inspection. */
  fetch?: typeof globalThis.fetch;
}

/**
 * The complete OpenBindings adapter for the OAS binding family.
 *
 * One instance can be registered for invocation, synthesis, and source
 * inspection. It contains no OpenAPI planner or executor: those remain in the
 * standalone client and its detached provider projection.
 */
export class OpenAPIAdapter implements BindingInvoker, CoverageSynthesizer, SourceInspector {
  private readonly invoker: OpenAPIInvoker;
  private readonly synthesizer: OpenAPISynthesizer;

  constructor(options: OpenAPIAdapterOptions = {}) {
    const { fetch, ...invokerOptions } = options;
    this.invoker = new OpenAPIInvoker(invokerOptions);
    this.synthesizer = new OpenAPISynthesizer(fetch ? { fetch } : undefined);
  }

  bindingSpecs(): BindingSpecInfo[] {
    return this.invoker.bindingSpecs();
  }

  checkBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
    return this.invoker.checkBindingSpecs(bindingSpecs);
  }

  invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
    return this.invoker.invokeBinding<I, O>(args);
  }

  prepareBinding(args: BindingInvocationArgs): Promise<ContextRequiredDetails | null> {
    return this.invoker.prepareBinding(args);
  }

  synthesizeInterface(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<OBInterface> {
    return this.synthesizer.synthesizeInterface(input, options);
  }

  synthesizeInterfaceWithCoverage(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<SynthesizeResult> {
    return this.synthesizer.synthesizeInterfaceWithCoverage(input, options);
  }

  inspectSource(
    source: Source,
    options?: { signal?: AbortSignal },
  ): Promise<SourceInspection> {
    return this.synthesizer.inspectSource(source, options);
  }
}

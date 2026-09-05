import type { BindingSpecInfo, BindingSpecVerdict, OBInterface, Source } from "@openbindings/core";
import {
  OperationInvoker,
  operationSignature,
  type BindingInvoker,
  type ContextRequiredDetails,
  type Invocation,
  type InvokeOptions,
  type OperationInvokerOptions,
  type OperationSignature,
} from "@openbindings/invoke";
import {
  combineSourceInspectors,
  combineSynthesizers,
  fetchInterface,
  type CoverageSynthesizer,
  type FetchedInterface,
  type InterfaceSynthesizer,
  type SourceInspection,
  type SourceInspector,
  type SynthesizeInput,
  type SynthesizeResult,
} from "@openbindings/synthesize";

/**
 * A cohesive binding implementation registered with the high-level runtime.
 * The component remains independently usable through each published contract.
 */
export interface BindingProvider extends BindingInvoker, InterfaceSynthesizer, SourceInspector {}

export interface OpenBindingsRuntimeOptions extends OperationInvokerOptions {
  /** Explicit, instance-scoped binding implementations. No global defaults are installed. */
  providers?: readonly BindingProvider[];
}

export interface ResolveInterfaceOptions {
  signal?: AbortSignal;
}

/**
 * Optional protocol-neutral facade over the SDK's independently published
 * invocation, synthesis, and inspection contracts.
 */
export class OpenBindingsRuntime {
  readonly operationInvoker: OperationInvoker;
  private readonly providers: readonly BindingProvider[];
  private readonly synthesizer: CoverageSynthesizer;
  private readonly inspector: SourceInspector;
  private readonly fetchFn?: typeof globalThis.fetch;

  constructor(options: OpenBindingsRuntimeOptions = {}) {
    const { providers = [], ...invokerOptions } = options;
    rejectDuplicateRegistrations(providers);
    this.providers = [...providers];
    this.fetchFn = invokerOptions.fetch;
    this.operationInvoker = new OperationInvoker([...providers], invokerOptions);
    this.synthesizer = combineSynthesizers(...providers);
    this.inspector = combineSourceInspectors(...providers);
  }

  /** Exact binding specifications registered by this runtime's providers. */
  bindingSpecs(): BindingSpecInfo[] {
    return this.operationInvoker.bindingSpecs();
  }

  /** Authoritatively check exact identifiers against the provider set. */
  checkBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
    return this.operationInvoker.checkBindingSpecs(bindingSpecs);
  }

  /** Resolve an OBI directly, through discovery, or through synthesis. */
  resolve(target: string, options?: ResolveInterfaceOptions): Promise<FetchedInterface> {
    return fetchInterface(target, {
      ...(this.fetchFn ? { fetch: this.fetchFn } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
      synthesizers: [...this.providers],
    });
  }

  /** Inspect a source through the provider selected by its exact identifier. */
  inspectSource(source: Source, options?: ResolveInterfaceOptions): Promise<SourceInspection> {
    return this.inspector.inspectSource(source, options);
  }

  /** Project binding sources into an OBI. */
  synthesizeInterface(
    input: SynthesizeInput,
    options?: ResolveInterfaceOptions,
  ): Promise<OBInterface> {
    return this.synthesizer.synthesizeInterface(input, options);
  }

  /** Project sources and return durable, exhaustiveness-qualified coverage. */
  synthesizeInterfaceWithCoverage(
    input: SynthesizeInput,
    options?: ResolveInterfaceOptions,
  ): Promise<SynthesizeResult> {
    return this.synthesizer.synthesizeInterfaceWithCoverage(input, options);
  }

  /** Perform side-effect-free context preflight for one operation. */
  prepareOperation(
    iface: OBInterface,
    operation: string,
    options?: InvokeOptions,
  ): Promise<ContextRequiredDetails | null> {
    return this.operationInvoker.prepareOperation(iface, operation, options);
  }

  /** Invoke dynamically by key or with a generated typed signature. */
  invoke<I = unknown, O = unknown>(
    iface: OBInterface,
    operation: string | OperationSignature<I, O>,
    options?: InvokeOptions,
  ): Invocation<I, O> {
    const signature = typeof operation === "string" ? operationSignature<I, O>(operation) : operation;
    return this.operationInvoker.invoke(iface, signature, options);
  }
}

function rejectDuplicateRegistrations(providers: readonly BindingProvider[]): void {
  const owners = new Map<string, number>();
  providers.forEach((provider, index) => {
    for (const { bindingSpec } of provider.bindingSpecs()) {
      const previous = owners.get(bindingSpec);
      if (previous !== undefined) {
        throw new TypeError(
          `binding specification ${JSON.stringify(bindingSpec)} is registered by providers ${previous} and ${index}`,
        );
      }
      owners.set(bindingSpec, index);
    }
  });
}

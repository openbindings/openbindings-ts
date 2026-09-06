import type {
  BindingSpecInfo,
  OBInterface,
  PreparedBindingDescriptor,
} from "@openbindings/core";
import { PreparedInterface, prepareInterface } from "@openbindings/core";
import type { ContextRequiredDetails, Invocation } from "./invocation.js";
import type { PreparedInvokeOptions, PreparedPreflightOptions } from "./operation-invoker.js";
import type { OperationSignature } from "./operation-signature.js";
import type { RealizationSelector } from "./composition-policy.js";

/** Runtime behavior returned for one SDK-selected exact binding descriptor. */
export interface CompiledRealizationBehavior<I = unknown, O = unknown> {
  invoke(options?: PreparedInvokeOptions): Invocation<I, O>;
  preflight(options?: PreparedPreflightOptions): Promise<ContextRequiredDetails | null>;
}

/**
 * Runtime capability used by PreparedProvider. It receives an SDK-prepared
 * interface and exact binding key; it supplies behavior, never OBI identity.
 */
export interface ProviderRuntime {
  bindingSpecs(): BindingSpecInfo[];
  /** Optional exact-descriptor eligibility refinement (for local registries). */
  supportsBinding?(binding: PreparedBindingDescriptor): boolean;
  compileOperationHandle<I = unknown, O = unknown>(
    preparedInterface: PreparedInterface,
    signature: OperationSignature<I, O>,
    options: { readonly bindingKey: string },
  ): CompiledRealizationBehavior<I, O>;
  dispose?(): void | Promise<void>;
}

export interface PreparedProviderOptions {
  /** Stable application-owned identity used in policy and diagnostics. */
  readonly key: string;
  readonly interface: OBInterface | PreparedInterface;
  readonly runtime: ProviderRuntime;
  readonly label?: string;
  /** Optional provider-runtime choice among that provider's eligible bindings. */
  readonly selectRealization?: RealizationSelector<PreparedRealizationDescriptor>;
}

export interface PreparedRealizationDescriptor {
  readonly operationKey: string;
  readonly bindingKey: string;
  readonly sourceKey: string;
  readonly bindingSpec: string;
  readonly selector: string;
  readonly supported: boolean;
  readonly binding: PreparedBindingDescriptor;
}

export class ProviderDisposedError extends Error {
  constructor(providerKey: string) {
    super(`openbindings: prepared provider is disposed: ${providerKey}`);
    this.name = "ProviderDisposedError";
  }
}

export class RealizationNotFoundError extends Error {
  constructor(providerKey: string, bindingKey: string) {
    super(
      `openbindings: provider ${JSON.stringify(providerKey)} has no executable realization for binding ${JSON.stringify(bindingKey)}`,
    );
    this.name = "RealizationNotFoundError";
  }
}

/**
 * Opaque, SDK-identified executable closure for one exact provider binding.
 */
export class PreparedRealization<I = unknown, O = unknown> {
  readonly #behavior: CompiledRealizationBehavior<I, O>;
  readonly #assertActive: () => void;

  readonly providerKey: string;
  readonly interfaceRevision: string;
  readonly operationKey: string;
  readonly bindingKey: string;
  readonly sourceKey: string;
  readonly bindingSpec: string;
  readonly selector: string;

  private constructor(
    provider: PreparedProvider,
    descriptor: PreparedRealizationDescriptor,
    behavior: CompiledRealizationBehavior<I, O>,
  ) {
    this.#behavior = behavior;
    this.#assertActive = () => provider.assertActive();
    this.providerKey = provider.key;
    this.interfaceRevision = provider.interface.revision;
    this.operationKey = descriptor.operationKey;
    this.bindingKey = descriptor.bindingKey;
    this.sourceKey = descriptor.sourceKey;
    this.bindingSpec = descriptor.bindingSpec;
    this.selector = descriptor.selector;
    Object.freeze(this);
  }

  invoke(options?: PreparedInvokeOptions): Invocation<I, O> {
    this.#assertActive();
    return this.#behavior.invoke(options);
  }

  preflight(options?: PreparedPreflightOptions): Promise<ContextRequiredDetails | null> {
    this.#assertActive();
    return this.#behavior.preflight(options);
  }

  /** @internal */
  static create<I, O>(
    provider: PreparedProvider,
    descriptor: PreparedRealizationDescriptor,
    behavior: CompiledRealizationBehavior<I, O>,
  ): PreparedRealization<I, O> {
    return new PreparedRealization(provider, descriptor, behavior);
  }
}

interface ProviderState {
  readonly runtime: ProviderRuntime;
  readonly specs: readonly BindingSpecInfo[];
  readonly descriptors: ReadonlyMap<string, PreparedRealizationDescriptor>;
  readonly byOperation: ReadonlyMap<string, readonly PreparedRealizationDescriptor[]>;
  readonly closed: Map<string, PreparedRealization>;
  disposed: boolean;
}

/**
 * A prepared OBI provider catalog. Catalog construction is indexed and lazy:
 * executable closures and schemas are compiled only for selected bindings.
 */
export class PreparedProvider {
  readonly #state: ProviderState;

  readonly key: string;
  readonly label?: string;
  readonly interface: PreparedInterface;
  readonly selectRealization?: RealizationSelector<PreparedRealizationDescriptor>;

  private constructor(
    options: PreparedProviderOptions,
    preparedInterface: PreparedInterface,
    state: ProviderState,
  ) {
    this.key = options.key;
    this.label = options.label;
    this.interface = preparedInterface;
    this.selectRealization = options.selectRealization;
    this.#state = state;
    Object.freeze(this);
  }

  get disposed(): boolean {
    return this.#state.disposed;
  }

  bindingSpecs(): readonly BindingSpecInfo[] {
    return this.#state.specs;
  }

  realization(bindingKey: string): PreparedRealizationDescriptor | undefined {
    return this.#state.descriptors.get(bindingKey);
  }

  realizationsForOperation(
    operationIdentifier: string,
  ): readonly PreparedRealizationDescriptor[] {
    const operation = this.interface.operation(operationIdentifier);
    return operation
      ? this.#state.byOperation.get(operation.canonicalKey) ?? Object.freeze([])
      : Object.freeze([]);
  }

  /**
   * Performs deterministic closure once. No live context preflight occurs.
   */
  closeRealization<I = unknown, O = unknown>(
    bindingKey: string,
  ): PreparedRealization<I, O> {
    this.assertActive();
    const cached = this.#state.closed.get(bindingKey);
    if (cached) return cached as PreparedRealization<I, O>;
    const descriptor = this.#state.descriptors.get(bindingKey);
    if (!descriptor?.supported) {
      throw new RealizationNotFoundError(this.key, bindingKey);
    }
    const behavior = this.#state.runtime.compileOperationHandle<I, O>(
      this.interface,
      Object.freeze({ key: descriptor.operationKey }),
      { bindingKey },
    );
    if (
      !behavior ||
      typeof behavior.invoke !== "function" ||
      typeof behavior.preflight !== "function"
    ) {
      throw new TypeError("openbindings: provider runtime returned invalid realization behavior");
    }
    const closed = PreparedRealization.create(this, descriptor, behavior);
    this.#state.closed.set(bindingKey, closed);
    return closed;
  }

  /** Disposes the provider and invalidates every retained realization. */
  async dispose(): Promise<void> {
    if (this.#state.disposed) return;
    this.#state.disposed = true;
    this.#state.closed.clear();
    await this.#state.runtime.dispose?.();
  }

  /** @internal */
  assertActive(): void {
    if (this.#state.disposed) throw new ProviderDisposedError(this.key);
  }

  /** @internal */
  static async create(options: PreparedProviderOptions): Promise<PreparedProvider> {
    if (!options.key.trim()) throw new TypeError("openbindings: provider key is required");
    if (!options.runtime || typeof options.runtime.bindingSpecs !== "function") {
      throw new TypeError("openbindings: provider runtime is required");
    }
    const preparedInterface = await prepareInterface(options.interface);
    const specs = Object.freeze(options.runtime.bindingSpecs().map(info =>
      Object.freeze({ ...info }),
    ));
    const supportedSpecs = new Set(specs.map(info => info.bindingSpec));
    const descriptors = new Map<string, PreparedRealizationDescriptor>();
    const byOperation = new Map<string, PreparedRealizationDescriptor[]>();
    for (const bindingKey of preparedInterface.bindingKeys()) {
      const binding = preparedInterface.binding(bindingKey)!;
      const descriptor = Object.freeze({
        operationKey: binding.operation.canonicalKey,
        bindingKey,
        sourceKey: binding.binding.source,
        bindingSpec: binding.bindingSpec,
        selector: binding.binding.selector ?? "",
        supported: supportedSpecs.has(binding.bindingSpec) &&
          (options.runtime.supportsBinding?.(binding) ?? true),
        binding,
      });
      descriptors.set(bindingKey, descriptor);
      const entries = byOperation.get(descriptor.operationKey);
      if (entries) entries.push(descriptor);
      else byOperation.set(descriptor.operationKey, [descriptor]);
    }
    const frozenByOperation = new Map<string, readonly PreparedRealizationDescriptor[]>();
    for (const [operation, entries] of byOperation) {
      frozenByOperation.set(operation, Object.freeze(entries));
    }
    return new PreparedProvider(options, preparedInterface, {
      runtime: options.runtime,
      specs,
      descriptors,
      byOperation: frozenByOperation,
      closed: new Map(),
      disposed: false,
    });
  }
}

export function prepareProvider(
  options: PreparedProviderOptions,
): Promise<PreparedProvider> {
  return PreparedProvider.create(options);
}

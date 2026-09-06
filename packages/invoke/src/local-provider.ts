import type { OBInterface, PreparedBindingDescriptor } from "@openbindings/core";
import { PreparedInterface, prepareInterface } from "@openbindings/core";
import {
  ERR_EXECUTION_FAILED,
  ERR_MISSING_INPUT,
  ERR_TOO_MANY_INPUTS,
} from "./errcodes.js";
import { InvocationError, type BindingHandle } from "./invocation.js";
import type { BindingInvocationArgs } from "./invoker-types.js";
import { HandlerBindingInvoker, type BindingHandlerPreparer } from "./handler-binding-invoker.js";
import { OperationInvoker, type OperationInvokerOptions } from "./operation-invoker.js";
import {
  prepareProvider,
  type PreparedProvider,
  type ProviderRuntime,
} from "./prepared-provider.js";
import type { RealizationSelector } from "./composition-policy.js";
import type { PreparedRealizationDescriptor } from "./prepared-provider.js";

export type LocalStreamHandler<I = unknown, O = unknown> = (
  handle: BindingHandle<I, O>,
  args: BindingInvocationArgs,
) => void | Promise<void>;

export type LocalUnaryHandler<I = unknown, O = unknown> = (
  input: I,
  args: BindingInvocationArgs,
) => O | Promise<O>;

/** Type-erased only after a generic factory has checked the implementation. */
export class LocalBindingImplementation {
  readonly #handler: LocalStreamHandler;
  readonly #prepare?: BindingHandlerPreparer;

  private constructor(
    handler: LocalStreamHandler,
    prepare?: BindingHandlerPreparer,
  ) {
    this.#handler = handler;
    this.#prepare = prepare;
    Object.freeze(this);
  }

  /** @internal Installs one captured implementation into its exact OBI address. */
  static install(
    implementation: LocalBindingImplementation,
    invoker: HandlerBindingInvoker,
    binding: PreparedBindingDescriptor,
  ): () => void {
    const location = binding.source.location;
    if (!location) {
      throw new TypeError(
        `openbindings: local binding ${JSON.stringify(binding.key)} source requires a location`,
      );
    }
    return invoker.register({
      location,
      ref: binding.binding.ref ?? "",
      handler: implementation.#handler,
      ...(implementation.#prepare === undefined
        ? {}
        : { prepare: implementation.#prepare }),
    });
  }

  /** @internal */
  static stream<I, O>(
    handler: LocalStreamHandler<I, O>,
    prepare?: BindingHandlerPreparer,
  ): LocalBindingImplementation {
    return new LocalBindingImplementation(
      handler as unknown as LocalStreamHandler,
      prepare,
    );
  }
}

/** Adapts a general streaming implementation without serialization. */
export function localStream<I = unknown, O = unknown>(
  handler: LocalStreamHandler<I, O>,
  options?: { readonly prepare?: BindingHandlerPreparer },
): LocalBindingImplementation {
  return LocalBindingImplementation.stream(handler, options?.prepare);
}

/**
 * Adapts the common exactly-one-input/one-output case. Input and output values
 * remain native references; the ordinary invocation handle still provides
 * validation, cancellation, backpressure, and terminal semantics.
 */
export function localUnary<I = unknown, O = unknown>(
  handler: LocalUnaryHandler<I, O>,
  options?: { readonly prepare?: BindingHandlerPreparer },
): LocalBindingImplementation {
  return LocalBindingImplementation.stream<I, O>(async (handle, args) => {
    try {
      const inputs = handle.inputs()[Symbol.asyncIterator]();
      const first = await inputs.next();
      await handle.closeInput();
      if (first.done) {
        handle.fireError(new InvocationError(ERR_MISSING_INPUT));
        return;
      }
      // closeInput rejects parked producers but intentionally preserves an
      // already accepted buffered value. Pull once more so a racing second
      // write cannot be silently discarded by the unary adapter.
      const second = await inputs.next();
      if (!second.done) {
        handle.fireError(new InvocationError(ERR_TOO_MANY_INPUTS));
        return;
      }
      const output = await handler(first.value, args);
      await handle.emitOutput(output);
      handle.closeOutput();
    } catch (error: unknown) {
      handle.fireError(
        error instanceof InvocationError
          ? error
          : new InvocationError(ERR_EXECUTION_FAILED),
      );
    }
  }, options?.prepare);
}

export interface PrepareLocalProviderOptions {
  readonly key: string;
  readonly interface: OBInterface | PreparedInterface;
  /** Exact OBI binding key -> native implementation. */
  readonly implementations: Readonly<Record<string, LocalBindingImplementation>>;
  readonly label?: string;
  readonly selectRealization?: RealizationSelector<PreparedRealizationDescriptor>;
  readonly operationInvoker?: OperationInvokerOptions;
}

/**
 * Prepares an in-process provider from binding-key implementations. The OBI is
 * still the sole contract/identity authority; functions remain outside it.
 */
export async function prepareLocalProvider(
  options: PrepareLocalProviderOptions,
): Promise<PreparedProvider> {
  const preparedInterface = await prepareInterface(options.interface);
  const invokers = new Map<string, HandlerBindingInvoker>();
  const cleanup: (() => void)[] = [];
  const implemented = new Set<string>();
  try {
    for (const bindingKey of Object.keys(options.implementations).sort()) {
      const implementation = options.implementations[bindingKey]!;
      if (!(implementation instanceof LocalBindingImplementation)) {
        throw new TypeError(
          `openbindings: local implementation ${JSON.stringify(bindingKey)} must be created by localStream or localUnary`,
        );
      }
      const binding = preparedInterface.binding(bindingKey);
      if (!binding) {
        throw new TypeError(
          `openbindings: local implementation references unknown binding ${JSON.stringify(bindingKey)}`,
        );
      }
      let invoker = invokers.get(binding.bindingSpec);
      if (!invoker) {
        invoker = new HandlerBindingInvoker({ bindingSpec: binding.bindingSpec });
        invokers.set(binding.bindingSpec, invoker);
      }
      cleanup.push(LocalBindingImplementation.install(implementation, invoker, binding));
      implemented.add(bindingKey);
    }

    const operationInvoker = new OperationInvoker(
      [...invokers.values()],
      options.operationInvoker,
    );
    let disposed = false;
    const runtime: ProviderRuntime = {
      bindingSpecs: () => operationInvoker.bindingSpecs(),
      supportsBinding: binding => implemented.has(binding.key),
      compileOperationHandle: (prepared, signature, invokeOptions) =>
        operationInvoker.compileOperationHandle(prepared, signature, invokeOptions),
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const remove of cleanup.splice(0)) remove();
      },
    };
    return await prepareProvider({
      key: options.key,
      interface: preparedInterface,
      runtime,
      ...(options.label === undefined ? {} : { label: options.label }),
      ...(options.selectRealization === undefined
        ? {}
        : { selectRealization: options.selectRealization }),
    });
  } catch (error: unknown) {
    for (const remove of cleanup.reverse()) remove();
    throw error;
  }
}

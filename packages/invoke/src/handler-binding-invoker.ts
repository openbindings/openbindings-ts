import { checkBindingSpecs as supportVerdicts } from "@openbindings/core";
import type { BindingSpecInfo, BindingSpecVerdict } from "@openbindings/core";
import { ERR_SELECTOR_NOT_FOUND, ERR_RUNTIME, ERR_SOURCE_CONFIG_ERROR } from "./errcodes.js";
import {
  contextRequiredError,
  InvocationError,
  InvocationImpl,
  type BindingHandle,
  type ContextRequiredDetails,
  type Invocation,
} from "./invocation.js";
import type { BindingInvocationArgs } from "./invoker-types.js";
import type { BindingInvoker, CompiledBindingInvoker } from "./invokers.js";

/**
 * An application-owned in-process implementation for one concrete binding.
 * The handler uses the same cardinality-agnostic handle as every other
 * binding invoker and receives values by reference; this adapter performs no
 * serialization or transport work.
 */
export type BindingHandler<I = unknown, O = unknown> = (
  handle: BindingHandle<I, O>,
  args: BindingInvocationArgs,
) => void | Promise<void>;

/** Side-effect-free preflight for one in-process binding implementation. */
export type BindingHandlerPreparer = (
  args: BindingInvocationArgs,
) => ContextRequiredDetails | null | Promise<ContextRequiredDetails | null>;

export interface HandlerBindingRegistration<I = unknown, O = unknown> {
  readonly location: string;
  readonly selector: string;
  readonly handler: BindingHandler<I, O>;
  readonly prepare?: BindingHandlerPreparer;
}

export interface HandlerBindingInvokerOptions {
  /**
   * Exact application- or ecosystem-owned binding-specification identifier.
   * This SDK intentionally does not define a universal "local" token.
   */
  readonly bindingSpec: string;
  readonly description?: string;
}

interface ErasedRegistration {
  handler: BindingHandler;
  prepare?: BindingHandlerPreparer;
}

function requireNonempty(value: string, field: string): void {
  if (!value.trim()) throw new TypeError(`openbindings: ${field} is required`);
}

function terminalError(error: unknown): InvocationError {
  return error instanceof InvocationError
    ? error
    : new InvocationError(ERR_RUNTIME);
}

/**
 * Experimental adapter from ordinary application handlers to BindingInvoker.
 *
 * The application owns the binding-specification token, registry lifetime,
 * and concrete `(source.location, binding.selector)` address space. Registration
 * is exact, duplicate-safe, and reversible. Invocation creation remains
 * inert: the handler starts in a later microtask and owns the ordinary
 * BindingHandle lifecycle.
 *
 * @experimental Low-level adapter behind prepared local providers. Most
 * applications should register `localUnary` or `localStream` implementations
 * by OBI binding key through `prepareLocalProvider`.
 */
export class HandlerBindingInvoker implements BindingInvoker {
  readonly #info: BindingSpecInfo;
  readonly #registrations = new Map<string, Map<string, ErasedRegistration>>();

  constructor(options: HandlerBindingInvokerOptions) {
    requireNonempty(options.bindingSpec, "binding specification");
    this.#info = {
      bindingSpec: options.bindingSpec,
      ...(options.description === undefined ? {} : { description: options.description }),
    };
  }

  bindingSpecs(): BindingSpecInfo[] {
    return [{ ...this.#info }];
  }

  checkBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
    return supportVerdicts(bindingSpecs, this.bindingSpecs());
  }

  /**
   * Registers one exact concrete implementation. The returned function only
   * removes this registration, so a stale cleanup cannot remove a later one.
   */
  register<I = unknown, O = unknown>(
    registration: HandlerBindingRegistration<I, O>,
  ): () => void {
    requireNonempty(registration.location, "handler binding location");
    const refs =
      this.#registrations.get(registration.location) ??
      new Map<string, ErasedRegistration>();
    if (refs.has(registration.selector)) {
      throw new TypeError(
        `openbindings: handler binding already registered: ${registration.location} ${JSON.stringify(registration.selector)}`,
      );
    }
    const erased: ErasedRegistration = {
      handler: registration.handler as BindingHandler,
      ...(registration.prepare === undefined ? {} : { prepare: registration.prepare }),
    };
    refs.set(registration.selector, erased);
    this.#registrations.set(registration.location, refs);

    return () => {
      const current = this.#registrations.get(registration.location);
      if (current?.get(registration.selector) !== erased) return;
      current.delete(registration.selector);
      if (current.size === 0) this.#registrations.delete(registration.location);
    };
  }

  async prepareBinding(
    args: BindingInvocationArgs,
  ): Promise<ContextRequiredDetails | null> {
    return this.#lookup(args).prepare?.(args) ?? null;
  }

  invokeBinding<I = unknown, O = unknown>(
    args: BindingInvocationArgs,
  ): Invocation<I, O> {
    const invocation = new InvocationImpl<I, O>({ signal: args.signal });
    queueMicrotask(() => void this.#run(args, invocation));
    return invocation;
  }

  /** Captures the exact handler registration for a prepared route. */
  compileBinding(args: BindingInvocationArgs): CompiledBindingInvoker {
    const registration = this.#lookup(args);
    return Object.freeze({
      prepareBinding: async (
        dynamicArgs: BindingInvocationArgs,
      ): Promise<ContextRequiredDetails | null> =>
        registration.prepare?.(dynamicArgs) ?? null,
      invokeBinding: <I = unknown, O = unknown>(
        dynamicArgs: BindingInvocationArgs,
      ): Invocation<I, O> => {
        const invocation = new InvocationImpl<I, O>({ signal: dynamicArgs.signal });
        queueMicrotask(() => void this.#runRegistration(registration, dynamicArgs, invocation));
        return invocation;
      },
      invokeBindingAfterPreflight: <I = unknown, O = unknown>(
        dynamicArgs: BindingInvocationArgs,
      ): Invocation<I, O> => {
        const invocation = new InvocationImpl<I, O>({ signal: dynamicArgs.signal });
        queueMicrotask(() => {
          if (invocation.signal.aborted) return;
          void Promise.resolve(registration.handler(invocation, dynamicArgs)).catch(
            error => invocation.fireError(terminalError(error)),
          );
        });
        return invocation;
      },
      invokeBindingHandle: async <I = unknown, O = unknown>(
        handle: BindingHandle<I, O>,
        dynamicArgs: BindingInvocationArgs,
      ): Promise<void> => {
        if (handle.signal.aborted) return;
        try {
          // The operation layer has already evaluated the captured
          // registration's prepare callback for this attempt. Calling the
          // handler directly removes the otherwise redundant inner
          // InvocationImpl without weakening the operation boundary.
          await registration.handler(handle, dynamicArgs);
        } catch (error: unknown) {
          handle.fireError(terminalError(error));
        }
      },
    });
  }

  async #run<I, O>(
    args: BindingInvocationArgs,
    invocation: InvocationImpl<I, O>,
  ): Promise<void> {
    if (invocation.signal.aborted) return;
    try {
      const registration = this.#lookup(args);
      await this.#runRegistration(registration, args, invocation);
    } catch (error: unknown) {
      invocation.fireError(terminalError(error));
    }
  }

  async #runRegistration<I, O>(
    registration: ErasedRegistration,
    args: BindingInvocationArgs,
    invocation: InvocationImpl<I, O>,
  ): Promise<void> {
    try {
      const requirements = await registration.prepare?.(args) ?? null;
      if (invocation.signal.aborted) return;
      if (requirements) {
        invocation.fireError(contextRequiredError(requirements));
        return;
      }
      await registration.handler(invocation, args);
    } catch (error: unknown) {
      invocation.fireError(terminalError(error));
    }
  }

  #lookup(args: BindingInvocationArgs): ErasedRegistration {
    const location = args.source.location;
    if (!location) throw new InvocationError(ERR_SOURCE_CONFIG_ERROR);
    const registration = this.#registrations.get(location)?.get(args.selector);
    if (!registration) throw new InvocationError(ERR_SELECTOR_NOT_FOUND);
    return registration;
  }
}

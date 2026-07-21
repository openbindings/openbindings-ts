import type {
  BindingInvocationArgs,
  BindingInvoker,
  BindingSpecInfo,
  Invocation,
} from "@openbindings/sdk";
import {
  ERR_EXECUTION_FAILED,
  ERR_INVALID_REF,
  ERR_REF_NOT_FOUND,
  ERR_RUNTIME,
  InvocationError,
  InvocationImpl,
} from "@openbindings/sdk";
import { BINDING_SPEC } from "./constants.js";

/**
 * The shape of a Cloudflare service binding when the target Worker exposes
 * a `WorkerEntrypoint` class. Each declared method on the class is callable
 * as a property on the binding, and the runtime handles structured-clone
 * serialization across the binding boundary.
 *
 * We accept any object with string-indexed function properties because we
 * don't want to depend on `@cloudflare/workers-types` from this package
 * (that'd force every consumer to also pull it in even when they're not
 * running on Workers — e.g. tests, codegen integration tests, doc tooling).
 */
export interface WorkersRpcBinding {
  [methodName: string]: (...args: unknown[]) => unknown;
}

/** Construction options for {@link WorkersRpcInvoker}. */
export interface WorkersRpcInvokerOptions {
  /**
   * The bound entrypoint object — typically `env.YOUR_BINDING_NAME` from
   * within a Worker. The invoker calls methods on this object directly.
   *
   * Provide this when constructing per-request: each Worker request gets a
   * fresh `env`, so the invoker should be constructed inside the request
   * handler, not at module load.
   */
  binding: WorkersRpcBinding;
}

/**
 * Invokes Workers RPC bindings by calling methods on a Cloudflare service
 * binding object.
 *
 * Usage from a Worker:
 *
 * ```ts
 * import { OperationInvoker, single } from "@openbindings/sdk";
 * import { WorkersRpcInvoker } from "@openbindings/workers-rpc";
 * import { createMyServiceInvoker } from "./generated/my-service-invoker.js";
 *
 * export default {
 *   async fetch(request, env, ctx) {
 *     const base = new OperationInvoker([
 *       new WorkersRpcInvoker({ binding: env.MY_SERVICE }),
 *     ]);
 *     // workers-rpc OBIs are embedded in the codegen output — the typed
 *     // invoker defaults to the embedded contract.
 *     const myService = createMyServiceInvoker(base);
 *     const call = myService.someMethod();
 *     await call.write({ foo: "bar" });
 *     const result = await single(call.outputs);
 *     // ...
 *   }
 * };
 * ```
 *
 * The `location` of a workers-rpc source is symbolic — there's no real
 * network dispatch, so the URL scheme `workers-rpc://` is a convention.
 * What matters for dispatch is the identifier (`workers-rpc@^1.0.0`)
 * matching the invoker's `bindingSpecs()` declaration exactly.
 *
 * Trust model: Workers RPC bindings are a Cloudflare-runtime feature.
 * Only sibling Workers that have the binding declared in their wrangler.toml
 * `[[services]]` block can reach the target. The Cloudflare runtime is the
 * trust boundary; this invoker doesn't perform any auth check itself.
 *
 * Error model: errors thrown by the target Worker's RPC method propagate
 * across the binding boundary as Error instances (with `name` and `message`
 * preserved by the structured-clone algorithm). The invoker catches them and
 * terminates the invocation with an `InvocationError` whose `code` is
 * `ERR_EXECUTION_FAILED`. Custom error subclasses are flattened to the base
 * Error shape; if the target wants to communicate structured error info, it
 * should return a discriminated-union result type from the method instead of
 * throwing.
 *
 * Streaming: Workers RPC supports streaming via async iterables, but this
 * invoker currently treats every method as unary (one output per call).
 * Streaming support could be added later by detecting iterable returns and
 * emitting multiple outputs.
 */
export class WorkersRpcInvoker implements BindingInvoker {
  private readonly binding: WorkersRpcBinding;

  constructor(options: WorkersRpcInvokerOptions) {
    this.binding = options.binding;
  }

  /** Returns the binding specifications this invoker supports, by exact identifier. */
  bindingSpecs(): BindingSpecInfo[] {
    return [{ bindingSpec: BINDING_SPEC, description: "Cloudflare Workers RPC bindings" }];
  }

  /**
   * Invokes a single binding by calling the corresponding method on the
   * service binding object and emitting its return value as the one output.
   *
   * The handle is returned synchronously and creation is inert: the actual
   * dispatch is scheduled on a microtask. Pre-dispatch failures (bad ref,
   * missing method) terminate the invocation before any call is made.
   *
   * The `ref` field of the binding entry is interpreted as the literal
   * method name on the WorkerEntrypoint class. There is no path encoding,
   * URL, or HTTP method — the ref IS the method name.
   *
   * Input flows through the handle: the binding reads the caller's first
   * `write` and passes it as the single argument to the method. If the
   * input side closes without a message, the method is called with no
   * arguments. Workers RPC's structured-clone serialization handles
   * object/array/etc. shapes; consumers should not pre-stringify.
   */
  invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
    const inv = new InvocationImpl<unknown, unknown>({ signal: args.signal });
    queueMicrotask(() => {
      void this.run(args, inv).catch((err) => {
        inv.fireError(
          err instanceof InvocationError
            ? err
            : new InvocationError(
                ERR_RUNTIME,
                err instanceof Error ? err.message : String(err),
              ),
        );
      });
    });
    return inv as Invocation<I, O>;
  }

  private async run(
    args: BindingInvocationArgs,
    inv: InvocationImpl<unknown, unknown>,
  ): Promise<void> {
    const methodName = args.ref;

    if (typeof methodName !== "string" || methodName.length === 0) {
      inv.fireError(
        new InvocationError(
          ERR_INVALID_REF,
          "workers-rpc binding ref must be a non-empty string (the method name on the WorkerEntrypoint class)",
        ),
      );
      return;
    }

    const method = this.binding[methodName];
    if (typeof method !== "function") {
      inv.fireError(
        new InvocationError(
          ERR_REF_NOT_FOUND,
          `The bound Worker entrypoint does not expose method "${methodName}". Check the WorkerEntrypoint class on the target Worker and the wrangler.toml entrypoint declaration.`,
        ),
      );
      return;
    }

    // Unary: read the caller's first (and only) input from the handle. A
    // clean close with no message means a no-argument call. Then close the
    // input side so the caller never has to.
    const first = await readFirst(inv.inputs());
    void inv.closeInput();

    // Service bindings have no abort plumbing, so checking before dispatch
    // is the practical cancellation point. When the signal is aborted the
    // handle has already fired ERR_CANCELLED; just stop.
    if (inv.signal.aborted) return;

    let result: unknown;
    try {
      // Invoke as a property access on the binding
      // (`this.binding[methodName](...)`) rather than
      // `method.call(this.binding, ...)`. On a Cloudflare ServiceStub
      // (the Worker `env.YOUR_BINDING` object) the methods live behind a
      // Proxy whose getter returns a dispatch function with the stub
      // captured internally as a closure variable. Using explicit
      // `.call(stub, ...)` makes the runtime treat `stub` as an extra
      // serializable argument, which fails with "This ServiceStub cannot
      // be serialized" because ServiceStubs are intentionally non-
      // serializable. Plain property invocation lets the proxy's getter
      // handle dispatch with the captured stub. Verified end-to-end
      // against wrangler dev with bidirectional service bindings.
      // Object.keys(stub) returns [] because the Proxy hides the method
      // names -- `typeof method === "function"` above still works
      // because Proxy's get trap returns the dispatch function.
      result = first.done
        ? await this.binding[methodName]()
        : await this.binding[methodName](first.value);
    } catch (err: unknown) {
      inv.fireError(
        new InvocationError(
          ERR_EXECUTION_FAILED,
          err instanceof Error ? err.message : String(err),
          err instanceof Error ? { name: err.name } : undefined,
        ),
      );
      return;
    }

    await inv.emitOutput(result);
    inv.closeOutput();
  }
}

/**
 * Reads the first message from the binding side of the handle. A `done`
 * result means the input side closed without a message (a no-argument
 * call); a terminal invocation error propagates as a rejection.
 */
async function readFirst<T>(it: AsyncIterable<T>): Promise<IteratorResult<T, void>> {
  return it[Symbol.asyncIterator]().next();
}

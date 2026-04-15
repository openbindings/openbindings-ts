import type {
  BindingExecutor,
  BindingExecutionInput,
  StreamEvent,
  FormatInfo,
} from "@openbindings/sdk";
import {
  ERR_INVALID_REF,
  ERR_REF_NOT_FOUND,
  ERR_EXECUTION_FAILED,
  ERR_CANCELLED,
} from "@openbindings/sdk";
import { FORMAT_TOKEN } from "./constants.js";

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

/** Construction options for {@link WorkersRpcExecutor}. */
export interface WorkersRpcExecutorOptions {
  /**
   * The bound entrypoint object — typically `env.YOUR_BINDING_NAME` from
   * within a Worker. The executor calls methods on this object directly.
   *
   * Provide this when constructing per-request: each Worker request gets a
   * fresh `env`, so the executor should be constructed inside the request
   * handler, not at module load.
   */
  binding: WorkersRpcBinding;
}

/**
 * Executes Workers RPC bindings by calling methods on a Cloudflare service
 * binding object.
 *
 * Usage from a Worker:
 *
 * ```ts
 * import { WorkersRpcExecutor } from "@openbindings/workers-rpc";
 * import { MyServiceClient } from "./generated/my-service-client.js";
 *
 * export default {
 *   async fetch(request, env, ctx) {
 *     const client = new MyServiceClient([
 *       new WorkersRpcExecutor({ binding: env.MY_SERVICE }),
 *     ]);
 *     await client.connect("workers-rpc://my-service");
 *     const result = await client.someMethod({ foo: "bar" });
 *     // ...
 *   }
 * };
 * ```
 *
 * The `connect()` URL is informational only — there's no real network
 * dispatch, so the URL scheme `workers-rpc://` is a convention. Any URL
 * works; the executor's `formats()` declaration is what matters for
 * format-token-based dispatch in `OperationExecutor`.
 *
 * Trust model: Workers RPC bindings are a Cloudflare-runtime feature.
 * Only sibling Workers that have the binding declared in their wrangler.toml
 * `[[services]]` block can reach the target. The Cloudflare runtime is the
 * trust boundary; this executor doesn't perform any auth check itself.
 *
 * Error model: errors thrown by the target Worker's RPC method propagate
 * across the binding boundary as Error instances (with `name` and `message`
 * preserved by the structured-clone algorithm). The executor catches them,
 * yields a `StreamEvent` with `error.code = "execution_failed"`, and ends
 * the stream. Custom error subclasses are flattened to the base Error shape;
 * if the target wants to communicate structured error info, it should
 * return a discriminated-union result type from the method instead of
 * throwing.
 *
 * Streaming: Workers RPC supports streaming via async iterables, but this
 * executor currently treats every method as unary (one yield per call).
 * Streaming support could be added later by detecting iterable returns and
 * yielding multiple events.
 */
export class WorkersRpcExecutor implements BindingExecutor {
  private readonly binding: WorkersRpcBinding;

  constructor(options: WorkersRpcExecutorOptions) {
    this.binding = options.binding;
  }

  /** Returns the format tokens this executor supports. */
  formats(): FormatInfo[] {
    return [{ token: FORMAT_TOKEN, description: "Cloudflare Workers RPC bindings" }];
  }

  /**
   * Executes a single binding by invoking the corresponding method on the
   * service binding object and yielding the result (or error) as a single
   * StreamEvent.
   *
   * The `ref` field of the binding entry is interpreted as the literal
   * method name on the WorkerEntrypoint class. There is no path encoding,
   * URL, or HTTP method — the ref IS the method name.
   *
   * The `input` field is passed as the single argument to the method.
   * Workers RPC's structured-clone serialization handles object/array/etc.
   * shapes; consumers should not pre-stringify.
   */
  async *executeBinding(
    input: BindingExecutionInput,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<StreamEvent> {
    const start = Date.now();
    const methodName = input.ref;

    if (typeof methodName !== "string" || methodName.length === 0) {
      yield {
        error: {
          code: ERR_INVALID_REF,
          message: "workers-rpc binding ref must be a non-empty string (the method name on the WorkerEntrypoint class)",
        },
        durationMs: Date.now() - start,
      };
      return;
    }

    const method = this.binding[methodName];
    if (typeof method !== "function") {
      yield {
        error: {
          code: ERR_REF_NOT_FOUND,
          message: `The bound Worker entrypoint does not expose method "${methodName}". Check the WorkerEntrypoint class on the target Worker and the wrangler.toml entrypoint declaration.`,
        },
        durationMs: Date.now() - start,
      };
      return;
    }

    if (options?.signal?.aborted) {
      yield {
        error: { code: ERR_CANCELLED, message: "Request aborted before dispatch" },
        durationMs: Date.now() - start,
      };
      return;
    }

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
      result = await this.binding[methodName](input.input);
    } catch (err: unknown) {
      yield {
        error: {
          code: ERR_EXECUTION_FAILED,
          message: err instanceof Error ? err.message : String(err),
          details: err instanceof Error ? { name: err.name } : undefined,
        },
        durationMs: Date.now() - start,
      };
      return;
    }

    yield {
      data: result,
      durationMs: Date.now() - start,
    };
  }
}

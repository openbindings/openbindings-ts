import type { OBInterface, BindingEntry, Transform, TransformOrRef } from "./types.js";
import { resolveTransform } from "./types.js";
import type {
  BindingExecutionInput,
  OperationExecutionInput,
  StreamEvent,
  FormatInfo,
} from "./executor-types.js";
import type {
  BindingExecutor,
  BindingSelector,
  TransformEvaluator,
} from "./executors.js";
import type { ContextStore, PlatformCallbacks } from "./context.js";
import {
  BindingNotFoundError,
  EmptyTransformExpressionError,
  MissingInterfaceError,
  NoTransformEvaluatorError,
  OperationNotFoundError,
  TransformRefNotFoundError,
  UnknownSourceError,
} from "./errors.js";
import { combineExecutors, type CombinedExecutor } from "./combiners.js";
import { ERR_BINDING_NOT_FOUND, ERR_TRANSFORM_ERROR } from "./errcodes.js";

export interface OperationExecutorOptions {
  bindingSelector?: BindingSelector;
  transformEvaluator?: TransformEvaluator;
  contextStore?: ContextStore;
  platformCallbacks?: PlatformCallbacks;
  fetch?: typeof globalThis.fetch;
}

export class OperationExecutor {
  readonly bindingSelector?: BindingSelector;
  readonly transformEvaluator?: TransformEvaluator;
  readonly contextStore?: ContextStore;
  readonly platformCallbacks?: PlatformCallbacks;
  readonly fetch?: typeof globalThis.fetch;

  private readonly executor: CombinedExecutor;

  constructor(executors: BindingExecutor[], opts?: OperationExecutorOptions) {
    this.bindingSelector = opts?.bindingSelector;
    this.transformEvaluator = opts?.transformEvaluator;
    this.contextStore = opts?.contextStore;
    this.platformCallbacks = opts?.platformCallbacks;
    this.fetch = opts?.fetch;
    this.executor = combineExecutors(...executors);
  }

  /**
   * Register an additional BindingExecutor after construction. Useful when
   * an executor depends on the OperationExecutor itself, creating a circular
   * dependency that cannot be resolved at construction time. Call during
   * initialization, before concurrent use.
   */
  addBindingExecutor(executor: BindingExecutor): void {
    this.executor.add(executor);
  }

  /**
   * Returns a new OperationExecutor sharing the combined executor but with
   * independent store/callbacks. Undefined arguments inherit the original's
   * values. Used by InterfaceClient to avoid mutating a shared executor.
   */
  withRuntime(
    store?: ContextStore,
    callbacks?: PlatformCallbacks,
    fetchFn?: typeof globalThis.fetch,
  ): OperationExecutor {
    const cp = Object.create(OperationExecutor.prototype) as OperationExecutor;
    (cp as any).bindingSelector = this.bindingSelector;
    (cp as any).transformEvaluator = this.transformEvaluator;
    (cp as any).contextStore = store ?? this.contextStore;
    (cp as any).platformCallbacks = callbacks ?? this.platformCallbacks;
    (cp as any).fetch = fetchFn ?? this.fetch;
    (cp as any).executor = this.executor;
    return cp;
  }

  formats(): FormatInfo[] {
    return this.executor.formats();
  }

  private availableFormats(): Set<string> {
    return new Set(this.executor.formats().map(f => f.token));
  }

  async *executeBinding(
    input: BindingExecutionInput,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<StreamEvent> {
    yield* this.executor.executeBinding(this.withRuntimeInput(input), options);
  }

  /**
   * Resolves an OBI operation to a binding and yields a stream of events.
   * Every operation is a stream — unary calls produce a single event.
   *
   * The executor's executeBinding returns AsyncIterable<StreamEvent>.
   * Input transforms apply once before execution. Output transforms apply
   * per event.
   */
  async *executeOperation(
    input: OperationExecutionInput,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<StreamEvent> {
    const iface = input.interface;
    if (!iface) throw new MissingInterfaceError();
    const op = iface.operations[input.operation];
    if (!op) {
      throw new OperationNotFoundError(input.operation);
    }

    let bindingKey: string;
    let binding: BindingEntry;

    if (input.bindingKey) {
      const b = iface.bindings?.[input.bindingKey];
      if (!b) {
        yield {
          error: {
            code: ERR_BINDING_NOT_FOUND,
            message: `Binding "${input.bindingKey}" is not defined on this interface.`,
          },
        };
        return;
      }
      bindingKey = input.bindingKey;
      binding = b;
    } else {
      const selector = this.bindingSelector ?? ((iface: OBInterface, op: string) =>
        defaultBindingSelector(iface, op, this.availableFormats()));
      ({ key: bindingKey, binding } = selector(iface, input.operation));
    }

    const source = iface.sources?.[binding.source];
    if (!source) throw new UnknownSourceError(bindingKey, binding.source);

    let execInput = input.input;

    if (binding.inputTransform) {
      if (!this.transformEvaluator) {
        yield {
          error: {
            code: ERR_TRANSFORM_ERROR,
            message: `${new NoTransformEvaluatorError(bindingKey).message}`,
          },
        };
        return;
      }
      try {
        execInput = await applyTransformRef(
          this.transformEvaluator,
          iface.transforms,
          binding.inputTransform,
          execInput,
        );
      } catch (e: unknown) {
        yield {
          error: {
            code: ERR_TRANSFORM_ERROR,
            message: `openbindings: input transform failed for "${bindingKey}": ${e instanceof Error ? e.message : String(e)}`,
          },
        };
        return;
      }
    }

    const securityMethods =
      binding.security && iface.security?.[binding.security]
        ? iface.security[binding.security]
        : undefined;

    const bindingIn: BindingExecutionInput = {
      source: {
        format: source.format,
        location: source.location,
        ...(source.content != null && !source.location
          ? { content: source.content }
          : {}),
      },
      ref: binding.ref ?? "",
      input: execInput,
      inputSchema: op.input,
      interface: iface,
      context: input.context,
      options: input.options,
      security: securityMethods,
    };

    yield* this.transformStream(
      this.executeBinding(bindingIn, options),
      binding,
      iface.transforms,
      bindingKey,
    );
  }

  /**
   * Wraps a stream of events, applying outputTransform to each event's data.
   * Passes through events without data or with errors unchanged.
   */
  private async *transformStream(
    source: AsyncIterable<StreamEvent>,
    binding: BindingEntry,
    transforms: Record<string, Transform> | undefined,
    bindingKey: string,
  ): AsyncGenerator<StreamEvent> {
    if (!binding.outputTransform) {
      yield* source;
      return;
    }
    if (!this.transformEvaluator) {
      yield {
        error: {
          code: ERR_TRANSFORM_ERROR,
          message: `${new NoTransformEvaluatorError(bindingKey).message}`,
        },
      };
      return;
    }
    for await (const ev of source) {
      if (ev.error || ev.data === undefined) {
        yield ev;
        continue;
      }
      try {
        const transformed = await applyTransformRef(
          this.transformEvaluator,
          transforms,
          binding.outputTransform,
          ev.data,
        );
        yield { data: transformed };
      } catch (e: unknown) {
        yield {
          error: {
            code: ERR_TRANSFORM_ERROR,
            message: `openbindings: output transform failed for "${bindingKey}": ${e instanceof Error ? e.message : String(e)}`,
          },
        };
      }
    }
  }

  /**
   * Returns a copy of input with store and callbacks filled from the
   * executor when the input doesn't already have them. Never mutates
   * the caller's input. Short-circuits when nothing needs filling.
   */
  private withRuntimeInput(input: BindingExecutionInput): BindingExecutionInput {
    const needStore = !input.store && this.contextStore;
    const needCallbacks = !input.callbacks && this.platformCallbacks;
    const needFetch = !input.fetch && this.fetch;
    if (!needStore && !needCallbacks && !needFetch) return input;
    return {
      ...input,
      store: input.store ?? this.contextStore,
      callbacks: input.callbacks ?? this.platformCallbacks,
      fetch: input.fetch ?? this.fetch,
    };
  }

}

/**
 * Picks the best binding for an operation. Non-deprecated bindings are
 * preferred. Lower priority values win (binding priority overrides source
 * priority). Ties broken alphabetically. When availableFormats is provided,
 * bindings whose source format is not in the set are skipped.
 */
export function defaultBindingSelector(
  iface: OBInterface,
  opKey: string,
  availableFormats?: Set<string>,
): { key: string; binding: BindingEntry } {
  if (!iface.bindings || Object.keys(iface.bindings).length === 0) {
    throw new BindingNotFoundError(opKey);
  }

  let bestKey: string | undefined;
  let best: BindingEntry | undefined;
  let bestPri = Infinity;
  let bestDeprecated = true;

  for (const [k, b] of Object.entries(iface.bindings)) {
    if (b.operation !== opKey) continue;

    const source = iface.sources?.[b.source];

    // Skip bindings whose source format the executor can't handle.
    if (availableFormats && source && !formatMatches(source.format, availableFormats)) continue;

    // Binding priority overrides source priority.
    const bPri = b.priority ?? source?.priority ?? Infinity;

    const betterDeprecation = bestDeprecated && !b.deprecated;
    const sameTier = (b.deprecated ?? false) === bestDeprecated;

    if (
      !best ||
      betterDeprecation ||
      (sameTier && bPri < bestPri) ||
      (sameTier && bPri === bestPri && k < bestKey!)
    ) {
      bestKey = k;
      best = b;
      bestPri = bPri;
      bestDeprecated = b.deprecated ?? false;
    }
  }

  if (!best || !bestKey) throw new BindingNotFoundError(opKey);
  return { key: bestKey, binding: best };
}

/**
 * Checks whether a source format token matches any token in the available set.
 * Handles versioned tokens: "openapi@3.1" matches "openapi@3.1" exactly,
 * and bare tokens like "mcp" match "mcp" or any "mcp@..." variant.
 */
function formatMatches(sourceFormat: string, available: Set<string>): boolean {
  if (available.has(sourceFormat)) return true;
  // Try bare token match: "mcp" matches if available has "mcp@..."
  const bare = sourceFormat.split("@")[0];
  for (const f of available) {
    if (f === bare || f.split("@")[0] === bare) return true;
  }
  return false;
}

async function applyTransformRef(
  evaluator: TransformEvaluator,
  transforms: Record<string, Transform> | undefined,
  transformOrRef: TransformOrRef,
  data: unknown,
): Promise<unknown> {
  const t = resolveTransform(transformOrRef, transforms);
  if (!t) {
    if (transformOrRef.$ref) throw new TransformRefNotFoundError(transformOrRef.$ref);
    throw new Error("openbindings: invalid transform: neither ref nor inline");
  }
  if (!t.expression) throw new EmptyTransformExpressionError();
  return evaluator.evaluate(t.expression, data);
}

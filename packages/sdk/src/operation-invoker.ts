import type { OBInterface, BindingEntry, Transform, TransformOrRef, JSONSchema } from "./types.js";
import { resolveTransform } from "./types.js";
import type {
  BindingInvocationInput,
  OperationInvocationInput,
  InvocationOutput,
  FormatInfo,
} from "./invoker-types.js";
import type {
  BindingInvoker,
  BindingSelector,
  TransformEvaluator,
} from "./invokers.js";
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
import { combineInvokers, type CombinedInvoker } from "./combiners.js";
import { ERR_BINDING_NOT_FOUND, ERR_TRANSFORM_ERROR, ERR_VALIDATION_FAILED } from "./errcodes.js";
import { matchesRange, parseRange } from "./format-token.js";
import { buildSchemaDefs, compileExampleSchema, safeValidate } from "./schema-validation.js";
import type { Validator } from "@cfworker/json-schema";

export interface OperationInvokerOptions {
  bindingSelector?: BindingSelector;
  transformEvaluator?: TransformEvaluator;
  contextStore?: ContextStore;
  platformCallbacks?: PlatformCallbacks;
  fetch?: typeof globalThis.fetch;
}

export class OperationInvoker {
  readonly bindingSelector?: BindingSelector;
  readonly transformEvaluator?: TransformEvaluator;
  readonly contextStore?: ContextStore;
  readonly platformCallbacks?: PlatformCallbacks;
  readonly fetch?: typeof globalThis.fetch;

  private readonly invoker: CombinedInvoker;

  constructor(invokers: BindingInvoker[], opts?: OperationInvokerOptions) {
    this.bindingSelector = opts?.bindingSelector;
    this.transformEvaluator = opts?.transformEvaluator;
    this.contextStore = opts?.contextStore;
    this.platformCallbacks = opts?.platformCallbacks;
    this.fetch = opts?.fetch;
    this.invoker = combineInvokers(...invokers);
  }

  /**
   * Register an additional BindingInvoker after construction. Useful when
   * an invoker depends on the OperationInvoker itself, creating a circular
   * dependency that cannot be resolved at construction time. Call during
   * initialization, before concurrent use.
   */
  addBindingInvoker(invoker: BindingInvoker): void {
    this.invoker.add(invoker);
  }

  /**
   * Returns a new OperationInvoker sharing the combined invoker but with
   * independent store/callbacks. Undefined arguments inherit the original's
   * values. Used by InterfaceClient to avoid mutating a shared invoker.
   */
  withRuntime(
    store?: ContextStore,
    callbacks?: PlatformCallbacks,
    fetchFn?: typeof globalThis.fetch,
  ): OperationInvoker {
    const cp = Object.create(OperationInvoker.prototype) as OperationInvoker;
    (cp as any).bindingSelector = this.bindingSelector;
    (cp as any).transformEvaluator = this.transformEvaluator;
    (cp as any).contextStore = store ?? this.contextStore;
    (cp as any).platformCallbacks = callbacks ?? this.platformCallbacks;
    (cp as any).fetch = fetchFn ?? this.fetch;
    (cp as any).invoker = this.invoker;
    return cp;
  }

  formats(): FormatInfo[] {
    return this.invoker.formats();
  }

  private availableFormats(): Set<string> {
    return new Set(this.invoker.formats().map(f => f.token));
  }

  async *invokeBinding(
    input: BindingInvocationInput,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<InvocationOutput> {
    yield* this.invoker.invokeBinding(this.withRuntimeInput(input), options);
  }

  /**
   * Resolves an OBI operation to a binding and yields a stream of events.
   * Every operation is a stream — unary calls produce a single event.
   *
   * The invoker's invokeBinding returns AsyncIterable<InvocationOutput>.
   * Input transforms apply once before invocation. Output transforms apply
   * per event.
   */
  async *invoke(
    input: OperationInvocationInput,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<InvocationOutput> {
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

    // OBI-T-07: Validate input against the operation's input schema before transform.
    if (op.input != null) {
      let inputValidator: Validator;
      try {
        inputValidator = compileExampleSchema(op.input, buildSchemaDefs(iface.schemas));
      } catch (err) {
        yield {
          error: {
            code: ERR_VALIDATION_FAILED,
            message: `openbindings: input schema compilation failed for "${input.operation}": ${(err as Error).message}`,
          },
        };
        return;
      }
      const r = safeValidate(inputValidator, input.input);
      if (!r.valid) {
        yield {
          error: {
            code: ERR_VALIDATION_FAILED,
            message: `openbindings: input validation failed for "${input.operation}": ${r.errors.join("; ")}`,
            details: { failures: r.failures },
          },
        };
        return;
      }
    }

    let invokeInput = input.input;

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
        invokeInput = await applyTransformRef(
          this.transformEvaluator,
          iface.transforms,
          binding.inputTransform,
          invokeInput,
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

    const bindingIn: BindingInvocationInput = {
      source: {
        format: source.format,
        location: source.location,
        ...(source.content != null ? { content: source.content } : {}),
      },
      ref: binding.ref ?? "",
      input: invokeInput,
      inputSchema: op.input ?? undefined,
      interface: iface,
      context: input.context,
      security: securityMethods,
    };

    yield* this.transformStream(
      this.invokeBinding(bindingIn, options),
      binding,
      iface.transforms,
      bindingKey,
      op.output ?? undefined,
      iface.schemas,
    );
  }

  /**
   * Wraps a stream of events, applying outputTransform to each event's data
   * and validating against outputSchema (OBI-T-08). Passes through events
   * without data or with errors unchanged.
   */
  private async *transformStream(
    source: AsyncIterable<InvocationOutput>,
    binding: BindingEntry,
    transforms: Record<string, Transform> | undefined,
    bindingKey: string,
    outputSchema?: JSONSchema,
    schemas?: Record<string, JSONSchema>,
  ): AsyncGenerator<InvocationOutput> {
    if (!binding.outputTransform && !outputSchema) {
      yield* source;
      return;
    }
    if (binding.outputTransform && !this.transformEvaluator) {
      yield {
        error: {
          code: ERR_TRANSFORM_ERROR,
          message: `${new NoTransformEvaluatorError(bindingKey).message}`,
        },
      };
      return;
    }

    // Compile output schema once outside the loop.
    let outputValidator: Validator | undefined;
    if (outputSchema) {
      try {
        outputValidator = compileExampleSchema(outputSchema, buildSchemaDefs(schemas));
      } catch (err) {
        yield {
          error: {
            code: ERR_VALIDATION_FAILED,
            message: `openbindings: output schema compilation failed for "${bindingKey}": ${(err as Error).message}`,
          },
        };
        for await (const _ of source) {
          // Drain producer.
        }
        return;
      }
    }

    for await (const ev of source) {
      if (ev.error) {
        yield ev;
        continue;
      }
      let data: unknown = ev.output;
      if (binding.outputTransform) {
        try {
          data = await applyTransformRef(
            this.transformEvaluator!,
            transforms,
            binding.outputTransform,
            data,
          );
        } catch (e: unknown) {
          yield {
            error: {
              code: ERR_TRANSFORM_ERROR,
              message: `openbindings: output transform failed for "${bindingKey}": ${e instanceof Error ? e.message : String(e)}`,
            },
          };
          continue;
        }
      }
      // OBI-T-08: Validate output after transform. On failure, yield the
      // data alongside the error so callers can inspect or render the
      // underlying response while still being informed of the schema
      // mismatch. The spec describes a T-08 failure as an "invocation
      // error for that operation"; it does not prescribe how the SDK
      // surfaces that error, and it does not require hiding the data.
      if (outputValidator) {
        const r = safeValidate(outputValidator, data);
        if (!r.valid) {
          yield {
            output: data,
            error: {
              code: ERR_VALIDATION_FAILED,
              message: `openbindings: output validation failed for "${bindingKey}": ${r.errors.join("; ")}`,
              details: { failures: r.failures },
            },
          };
          continue;
        }
      }
      yield { output: data };
    }
  }

  /**
   * Returns a copy of input with store and callbacks filled from the
   * invoker when the input doesn't already have them. Never mutates
   * the caller's input. Short-circuits when nothing needs filling.
   */
  private withRuntimeInput(input: BindingInvocationInput): BindingInvocationInput {
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

    // Skip bindings whose source format the invoker can't handle.
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
 * Checks whether a source format token satisfies any advertised token/range.
 */
function formatMatches(sourceFormat: string, available: Set<string>): boolean {
  if (available.has(sourceFormat)) return true;
  for (const f of available) {
    try {
      if (matchesRange(parseRange(f), sourceFormat)) return true;
    } catch {
      // Ignore malformed advertised ranges.
    }
  }
  return false;
}

async function applyTransformRef(
  evaluator: TransformEvaluator,
  transforms: Record<string, Transform> | undefined,
  transformOrRef: TransformOrRef,
  data: unknown,
): Promise<unknown> {
  const expr = resolveTransform(transformOrRef, transforms);
  if (expr === undefined) {
    if (typeof transformOrRef === "object" && transformOrRef !== null && transformOrRef.$ref) {
      throw new TransformRefNotFoundError(transformOrRef.$ref);
    }
    throw new Error("openbindings: invalid transform: neither ref nor inline");
  }
  if (expr === "") throw new EmptyTransformExpressionError();
  return evaluator.evaluate(expr, data);
}

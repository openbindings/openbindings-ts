import type { OBInterface, BindingEntry, Operation, Source, Transform, TransformOrRef, JSONSchema } from "./types.js";
import { resolveTransform } from "./types.js";
import type {
  BindingInvocationArgs,
  OperationInvocationArgs,
  FormatInfo,
} from "./invoker-types.js";
import type {
  BindingInvoker,
  BindingSelector,
  ContextResolver,
  TransformEvaluator,
} from "./invokers.js";
import {
  type ContextRequiredDetails,
  type Invocation,
  InvocationError,
  InvocationImpl,
  contextRequiredError,
  isContextRequired,
} from "./invocation.js";
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
import { resolveOperation, allOperationIdentifiers } from "./resolve-operation.js";
import {
  ERR_BINDING_NOT_FOUND,
  ERR_INPUT_CLOSED,
  ERR_RUNTIME,
  ERR_TRANSFORM_ERROR,
  ERR_VALIDATION_FAILED,
} from "./errcodes.js";
import { matchesRange, parseRange } from "./format-token.js";
import { buildSchemaDefs, compileExampleSchema, safeValidate } from "./schema-validation.js";
import type { Validator } from "@cfworker/json-schema";

/**
 * Maximum CONTEXT_REQUIRED resolve-and-retry rounds per invocation. A
 * binding that keeps challenging after resolution is either mis-declaring
 * its requirements or being fed an insufficient resolver; surfacing beats
 * looping.
 */
const MAX_CONTEXT_ROUNDS = 3;

export interface OperationInvokerOptions {
  bindingSelector?: BindingSelector;
  transformEvaluator?: TransformEvaluator;
  /**
   * Resolves CONTEXT_REQUIRED challenges raised by bindings. When unset, or
   * when it declines (returns null), the challenge surfaces to the caller
   * as an ordinary terminal InvocationError.
   */
  contextResolver?: ContextResolver;
  fetch?: typeof globalThis.fetch;
}

/**
 * The operation-layer invoker: resolves an OBI operation to a binding
 * (OBI-T-12 name resolution, OBI-T-09 selection) and returns a
 * cardinality-agnostic {@link Invocation} handle.
 *
 * Between the caller and the binding it enforces the operation contract:
 *   - OBI-T-07: every caller input validates against the operation's input
 *     schema BEFORE the input transform; a failure is terminal and rejects
 *     the offending `write` with the same error.
 *   - inputTransform / outputTransform evaluate per message (JSONata 2.0).
 *   - OBI-T-08: each (transformed) output validates against the output
 *     schema before it is emitted; a failure is terminal and the value is
 *     not emitted. Callers that need to inspect unvalidated payloads call
 *     `invokeBinding` directly.
 *   - CONTEXT_REQUIRED negotiation: challenges raised by the binding before
 *     any input was consumed are resolved via the configured resolver and
 *     the binding is re-driven against the same input buffer (the
 *     already-forwarded prefix is replayed). Once the binding shows
 *     observable progress (a first output), challenges surface to the
 *     caller instead.
 *
 * `invoke` throws synchronously on wiring/document errors (unknown
 * operation, binding, or source) — failures knowable before any work
 * starts. Runtime outcomes travel on the handle.
 */
export class OperationInvoker {
  readonly bindingSelector?: BindingSelector;
  readonly transformEvaluator?: TransformEvaluator;
  readonly contextResolver?: ContextResolver;
  readonly fetch?: typeof globalThis.fetch;

  private readonly invoker: CombinedInvoker;

  constructor(invokers: BindingInvoker[], opts?: OperationInvokerOptions) {
    this.bindingSelector = opts?.bindingSelector;
    this.transformEvaluator = opts?.transformEvaluator;
    this.contextResolver = opts?.contextResolver;
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
   * Returns a new OperationInvoker sharing the combined invoker registry
   * but with an independent context resolver / fetch. Undefined arguments
   * inherit the original's values. Useful when one OperationInvoker serves
   * call sites with different runtimes.
   */
  withRuntime(resolver?: ContextResolver, fetchFn?: typeof globalThis.fetch): OperationInvoker {
    const cp = new OperationInvoker([], {
      bindingSelector: this.bindingSelector,
      transformEvaluator: this.transformEvaluator,
      contextResolver: resolver ?? this.contextResolver,
      fetch: fetchFn ?? this.fetch,
    });
    // Share the underlying combined-invoker registry rather than re-combining
    // (which would lose any invokers added via addBindingInvoker on the source).
    (cp as unknown as { invoker: CombinedInvoker }).invoker = this.invoker;
    return cp;
  }

  formats(): FormatInfo[] {
    return this.invoker.formats();
  }

  private availableFormats(): Set<string> {
    return new Set(this.invoker.formats().map(f => f.token));
  }

  /**
   * Binding-layer passthrough: invoke a resolved binding directly, without
   * operation-layer validation, transforms, or context negotiation.
   */
  invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
    return this.invoker.invokeBinding<I, O>(this.withFetch(args));
  }

  /** Side-effect-free preflight for a resolved binding (binding-invoker role `prepareBinding`). */
  prepareBinding(args: BindingInvocationArgs): Promise<ContextRequiredDetails | null> {
    return this.invoker.prepareBinding(this.withFetch(args));
  }

  /**
   * Resolves an OBI operation to a binding and returns the invocation
   * handle. Returns synchronously; creation is inert (no I/O until the
   * invocation is driven).
   *
   * Contract narrowing vs the bare handle: `header` on an operation-layer
   * invocation settles with the binding's metadata at the FIRST DELIVERED
   * output (or at terminal), not the instant the binding sets it — forwarding
   * any earlier would pin metadata from an attempt that CONTEXT_REQUIRED
   * negotiation may yet discard and re-drive.
   */
  invoke<I = unknown, O = unknown>(args: OperationInvocationArgs): Invocation<I, O> {
    const iface = args.interface;
    if (!iface) throw new MissingInterfaceError();

    // OBI-T-12: resolve against the flat key+aliases namespace. Bindings
    // are selected by the resolved canonical key, not the name used.
    const resolved = resolveOperation(iface, args.operation);
    if (!resolved) {
      throw new OperationNotFoundError(args.operation, allOperationIdentifiers(iface));
    }
    const { key: opKey, operation: op } = resolved;

    let bindingKey: string;
    let binding: BindingEntry;
    if (args.bindingKey) {
      const b = iface.bindings?.[args.bindingKey];
      if (!b) throw new BindingNotFoundError(args.bindingKey);
      // An explicit bindingKey must name a binding FOR the resolved operation.
      // Without this check a caller could invoke any binding under the guise of
      // any operation, applying the wrong operation's input/output schema and
      // transforms. Same refusal (ERR_BINDING_NOT_FOUND) as the Go fix.
      if (b.operation !== opKey) {
        throw new BindingNotFoundError(opKey);
      }
      bindingKey = args.bindingKey;
      binding = b;
    } else {
      const selector = this.bindingSelector ?? ((i: OBInterface, o: string) =>
        defaultBindingSelector(i, o, this.availableFormats()));
      ({ key: bindingKey, binding } = selector(iface, opKey));
    }

    const source = iface.sources?.[binding.source];
    if (!source) throw new UnknownSourceError(bindingKey, binding.source);

    const callerInv = new InvocationImpl<I, O>({
      signal: args.signal,
      validateInput: makeInputValidator(op, iface, args.operation),
    });

    queueMicrotask(() => {
      this.run(callerInv, iface, op, binding, bindingKey, source, args.context).catch((err) => {
        callerInv.fireError(asInvocationError(err));
      });
    });

    return callerInv;
  }

  /**
   * Drives the binding-layer invocation(s) behind one caller-facing handle:
   * an input pump forwarding (transformed) caller inputs, an output loop
   * forwarding (transformed, T-08-validated) binding outputs, and the
   * CONTEXT_REQUIRED resolve-replay-retry machinery between attempts.
   */
  private async run<I, O>(
    callerInv: InvocationImpl<I, O>,
    iface: OBInterface,
    op: Operation,
    binding: BindingEntry,
    bindingKey: string,
    source: Source,
    initialContext: Record<string, unknown> | undefined,
  ): Promise<void> {
    const evaluator = this.transformEvaluator;
    if ((binding.inputTransform || binding.outputTransform) && !evaluator) {
      callerInv.fireError(
        new InvocationError(ERR_TRANSFORM_ERROR, new NoTransformEvaluatorError(bindingKey).message),
      );
      return;
    }

    // OBI-T-08: compile the output schema once per invocation.
    let outputValidator: Validator | undefined;
    if (op.output != null) {
      try {
        outputValidator = compileExampleSchema(op.output, buildSchemaDefs(iface.schemas));
      } catch (err) {
        callerInv.fireError(
          new InvocationError(
            ERR_VALIDATION_FAILED,
            `openbindings: output schema compilation failed for "${bindingKey}": ${(err as Error).message}`,
          ),
        );
        return;
      }
    }

    let context = initialContext;
    const bindingArgs = (): BindingInvocationArgs =>
      this.withFetch({
        source: {
          format: source.format,
          location: source.location,
          ...(source.content != null ? { content: source.content } : {}),
        },
        ref: binding.ref ?? "",
        binding,
        inputSchema: op.input ?? undefined,
        interface: iface,
        context,
        signal: callerInv.signal,
      });

    const mergeResolved = (resolved: Record<string, unknown>): void => {
      context = { ...(context ?? {}), ...resolved };
    };

    // Preflight (binding-invoker role `prepareBinding`): collapse
    // knowable-upfront context challenges into the clean
    // no-input-consumed case before anything is forwarded.
    try {
      const details = await this.invoker.prepareBinding(bindingArgs());
      if (details) {
        const resolvedCtx = this.contextResolver ? await this.contextResolver(details) : null;
        if (!resolvedCtx) {
          callerInv.fireError(
            contextRequiredError("openbindings: binding requires context", details),
          );
          return;
        }
        mergeResolved(resolvedCtx);
      }
    } catch (err) {
      callerInv.fireError(wireError(err));
      return;
    }

    // ----- shared input machinery (survives attempt swaps) -----

    // The single reader of the caller's input buffer. At most one next() is
    // in flight; its result lands in `stash` and survives a retry swap, so
    // no caller input is ever lost between attempts.
    const callerInputs = callerInv.inputs()[Symbol.asyncIterator]();
    let stash: { r?: IteratorResult<I, void>; err?: unknown } | null = null;
    let pulling = false;
    let wakeWaiters: (() => void)[] = [];
    const wake = (): void => {
      const ws = wakeWaiters;
      wakeWaiters = [];
      for (const w of ws) w();
    };
    const waitSignal = (): Promise<void> => new Promise((res) => wakeWaiters.push(res));
    const ensurePull = (): void => {
      if (pulling || stash) return;
      pulling = true;
      callerInputs.next().then(
        (r) => { pulling = false; stash = { r }; wake(); },
        (err) => { pulling = false; stash = { err }; wake(); },
      );
    };

    // Inputs already forwarded to the binding, post-transform, recorded for
    // replay while the retry window is open. The window closes at the
    // binding's first output (observable progress: by the binding contract,
    // CONTEXT_REQUIRED precedes any side effect, so a challenge after
    // output cannot be retried safely).
    let replayLog: unknown[] = [];
    let retryEligible = true;
    let attemptGen = 0;

    const pumpInputs = async (inner: Invocation<unknown, unknown>): Promise<void> => {
      const myGen = attemptGen;
      // Replay the prefix the previous attempt(s) already consumed. Snapshot
      // the ARRAY REFERENCE first: this attempt's own first output closes the
      // retry window and rebinds `replayLog` to a fresh empty array — the
      // snapshot keeps the in-flight replay iterating the full prefix instead
      // of being truncated mid-loop (which would silently drop inputs).
      const replay = replayLog;
      for (let i = 0; i < replay.length; i++) {
        try {
          await inner.write(replay[i]);
        } catch (err) {
          if (err instanceof InvocationError && err.code === ERR_INPUT_CLOSED) {
            // Same propagation as the live loop below: the binding stopped
            // reading; further caller writes must reject rather than be
            // silently accepted into a buffer nobody drains.
            void callerInv.closeInput();
          }
          return; // inner terminal or input-closed; the output loop owns reporting
        }
      }
      while (attemptGen === myGen) {
        if (stash) {
          const s = stash;
          stash = null;
          if (s.err) return; // caller side terminal (T-07 / cancel)
          const r = s.r!;
          if (r.done) {
            try { await inner.close(); } catch { /* inner already terminal */ }
            return;
          }
          let v: unknown = r.value;
          if (binding.inputTransform) {
            try {
              v = await applyTransformRef(evaluator!, iface.transforms, binding.inputTransform, v);
            } catch (e) {
              await inner.cancel();
              callerInv.fireError(
                new InvocationError(
                  ERR_TRANSFORM_ERROR,
                  `openbindings: input transform failed for "${bindingKey}": ${e instanceof Error ? e.message : String(e)}`,
                ),
              );
              return;
            }
          }
          if (retryEligible) replayLog.push(v);
          try {
            await inner.write(v);
          } catch (err) {
            if (err instanceof InvocationError && err.code === ERR_INPUT_CLOSED) {
              // The binding closed its input side deliberately (no-input /
              // unary / read-enough): propagate so further caller writes
              // reject, and stop forwarding. Outputs continue to flow.
              void callerInv.closeInput();
              return;
            }
            // Inner terminal: if a retry follows, v is in the replay log.
            return;
          }
          continue;
        }
        ensurePull();
        await waitSignal();
      }
    };

    // ----- attempt loop -----

    let headerForwarded = false;
    const forwardHeader = async (inner: Invocation<unknown, unknown>): Promise<void> => {
      if (headerForwarded) return;
      headerForwarded = true;
      callerInv.setHeader(await inner.header);
    };

    let rounds = 0;
    for (;;) {
      let inner: Invocation<unknown, unknown>;
      try {
        inner = this.invoker.invokeBinding(bindingArgs());
      } catch (err) {
        callerInv.fireError(wireError(err));
        return;
      }

      attemptGen++;
      const pump = pumpInputs(inner);

      let surface: InvocationError | undefined;
      let retry = false;
      try {
        for await (const out of inner.outputs) {
          if (retryEligible) {
            retryEligible = false;
            replayLog = [];
          }
          let data: unknown = out;
          if (binding.outputTransform) {
            try {
              data = await applyTransformRef(evaluator!, iface.transforms, binding.outputTransform, data);
            } catch (e) {
              await inner.cancel();
              surface = new InvocationError(
                ERR_TRANSFORM_ERROR,
                `openbindings: output transform failed for "${bindingKey}": ${e instanceof Error ? e.message : String(e)}`,
              );
              break;
            }
          }
          // OBI-T-08: an invalid output is not emitted; the invocation
          // terminates. Per-item for streaming bindings.
          if (outputValidator) {
            const r = safeValidate(outputValidator, data);
            if (!r.valid) {
              await inner.cancel();
              surface = new InvocationError(
                ERR_VALIDATION_FAILED,
                `openbindings: output validation failed for "${bindingKey}": ${r.errors.join("; ")}`,
                { failures: r.failures },
              );
              break;
            }
          }
          await forwardHeader(inner);
          try {
            await callerInv.emitOutput(data as O);
          } catch {
            // Caller-side terminal (cancel / abandoned iteration): tear
            // down the binding and stop. Nothing to report — the caller
            // handle is already terminal.
            await inner.cancel();
            break;
          }
        }
      } catch (err) {
        const invErr = asInvocationError(err);
        if (
          isContextRequired(invErr) &&
          retryEligible &&
          this.contextResolver &&
          rounds < MAX_CONTEXT_ROUNDS
        ) {
          const resolvedCtx = await this.contextResolver(invErr.details);
          if (resolvedCtx) {
            mergeResolved(resolvedCtx);
            retry = true;
          } else {
            surface = invErr;
          }
        } else {
          surface = invErr;
        }
      }

      // Unpark and retire this attempt's pump before deciding next steps —
      // the shared stash must have exactly one consumer at a time.
      attemptGen++;
      wake();
      await pump;

      if (retry) {
        rounds++;
        continue;
      }

      // Metadata forwarding races a concurrent caller-side terminal (cancel):
      // setHeader/setTrailer throw on a settled handle. Guard explicitly —
      // when the caller handle already terminated there is nothing to forward
      // and nothing left to report.
      try {
        await forwardHeader(inner);
        const t = terminalTrailer(inner);
        if (t) callerInv.setTrailer(t);
      } catch {
        // Caller handle already terminal; metadata can no longer land.
      }
      if (surface) {
        callerInv.fireError(surface);
      } else {
        callerInv.closeOutput();
      }
      return;
    }
  }

  /**
   * Returns a copy of args with fetch filled from the invoker when the args
   * don't already carry one. Never mutates the caller's args.
   */
  private withFetch(args: BindingInvocationArgs): BindingInvocationArgs {
    if (args.fetch || !this.fetch) return args;
    return { ...args, fetch: this.fetch };
  }
}

/** Builds the OBI-T-07 write-validation hook for an operation, compiling lazily on first write. */
function makeInputValidator(
  op: Operation,
  iface: OBInterface,
  operationName: string,
): ((input: unknown) => InvocationError | null) | undefined {
  if (op.input == null) return undefined;
  let validator: Validator | undefined;
  let compileError: InvocationError | undefined;
  let compiled = false;
  return (input: unknown): InvocationError | null => {
    if (!compiled) {
      compiled = true;
      try {
        validator = compileExampleSchema(op.input!, buildSchemaDefs(iface.schemas));
      } catch (err) {
        compileError = new InvocationError(
          ERR_VALIDATION_FAILED,
          `openbindings: input schema compilation failed for "${operationName}": ${(err as Error).message}`,
        );
      }
    }
    if (compileError) return compileError;
    const r = safeValidate(validator!, input);
    if (!r.valid) {
      return new InvocationError(
        ERR_VALIDATION_FAILED,
        `openbindings: input validation failed for "${operationName}": ${r.errors.join("; ")}`,
        { failures: r.failures },
      );
    }
    return null;
  };
}

/** Reads the inner invocation's trailer, tolerating a non-terminal handle. */
function terminalTrailer(inner: Invocation<unknown, unknown>): Record<string, string[]> | null {
  try {
    const t = inner.trailer();
    return Object.keys(t).length > 0 ? t : null;
  } catch {
    return null;
  }
}

function asInvocationError(err: unknown): InvocationError {
  if (err instanceof InvocationError) return err;
  return new InvocationError(
    ERR_RUNTIME,
    err instanceof Error ? err.message : String(err),
  );
}

/** Converts wiring errors (no invoker for format) raised mid-run into terminal invocation errors. */
function wireError(err: unknown): InvocationError {
  if (err instanceof InvocationError) return err;
  if (err instanceof Error && err.name === "NoInvokerError") {
    return new InvocationError(ERR_BINDING_NOT_FOUND, err.message);
  }
  return asInvocationError(err);
}

/**
 * Picks the best binding for an operation (OBI-T-09). Non-deprecated
 * bindings are preferred. Higher preference values win (binding preference
 * overrides source preference; an absent preference is the neutral baseline
 * of 0). Ties broken alphabetically. When availableFormats is provided,
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
  let bestPref = -Infinity;
  let bestDeprecated = true;

  for (const [k, b] of Object.entries(iface.bindings)) {
    if (b.operation !== opKey) continue;

    const source = iface.sources?.[b.source];

    // Skip bindings whose source format the invoker can't handle.
    if (availableFormats && source && !formatMatches(source.format, availableFormats)) continue;

    // Binding preference overrides source preference; absent on both is the
    // neutral baseline of 0.
    const bPref = b.preference ?? source?.preference ?? 0;

    const betterDeprecation = bestDeprecated && !b.deprecated;
    const sameTier = (b.deprecated ?? false) === bestDeprecated;

    if (
      !best ||
      betterDeprecation ||
      (sameTier && bPref > bestPref) ||
      (sameTier && bPref === bestPref && k < bestKey!)
    ) {
      bestKey = k;
      best = b;
      bestPref = bPref;
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

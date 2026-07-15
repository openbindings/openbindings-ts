import type { OBInterface, BindingEntry, Operation, Source, Transform, TransformOrRef, JSONSchema } from "./types.js";
import { resolveTransform } from "./types.js";
import type {
  BindingInvocationArgs,
  InvokeOptions,
  FormatInfo,
} from "./invoker-types.js";
import type { OperationSignature } from "./operation-signature.js";
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
import { contextConfiguration } from "./context.js";
import { resolveOperation, allOperationIdentifiers } from "./resolve-operation.js";
import {
  ERR_BINDING_NOT_FOUND,
  ERR_SCHEMA_UNRESOLVED,
  ERR_INPUT_CLOSED,
  ERR_RUNTIME,
  ERR_TRANSFORM_ERROR,
  ERR_VALIDATION_FAILED,
} from "./errcodes.js";
import { matchesRange, parseRange } from "./format-token.js";
import { buildSchemaDefs, compileExampleSchema, safeValidate , type CompiledSchema } from "./schema-validation.js";
import {
  type FieldRouter,
  type InvokeHooks,
  type InvokeSite,
  type OutputDecoder,
  type ResultClassifier,
  assumptionWarning,
  floorStamped,
  newInvokeHooks,
} from "./hooks.js";

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
  /**
   * Invoker-level consumer hooks (specification + configuration = complete
   * invocation): consulted after any per-invocation hook declines, before
   * the format built-in. Site-guard your hook bodies (site.operation,
   * siteFormatName) when the invoker serves multiple interfaces.
   */
  outputDecoder?: OutputDecoder;
  resultClassifier?: ResultClassifier;
  fieldRouter?: FieldRouter;
}

/**
 * The operation-layer invoker: resolves an OBI operation to a binding
 * (OBI-T-12 name resolution; selection by the operation-invoker contract's
 * default policy, consumer-overridable via context.configuration.selection)
 * and returns a
 * cardinality-agnostic {@link Invocation} handle.
 *
 * Between the caller and the binding it enforces the operation contract:
 * (validation carries the core's claim semantics, OBI-T-16: complete
 * statically reachable schema graph, `format` as annotation, per value; a
 * mismatch is ERR_VALIDATION_FAILED, an unresolvable governing graph is
 * ERR_SCHEMA_UNRESOLVED, never partial validation):
 *   - every caller input validates against the operation's input schema
 *     BEFORE the input transform; a failure is terminal and rejects the
 *     offending `write` with the same error.
 *   - inputTransform / outputTransform evaluate per message (JSONata 2.1).
 *   - each (transformed) output validates against the output schema before
 *     it is emitted; a failure is terminal and the value is not emitted.
 *     Callers that need to inspect unvalidated payloads call
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
  /**
   * Invoker-level consumer hooks — mutable public fields (the Go SDK's
   * house style): an embedder installs its standing table here after
   * construction. Snapshotted per invoke; later mutation does not affect
   * in-flight invocations.
   */
  outputDecoder?: OutputDecoder;
  resultClassifier?: ResultClassifier;
  fieldRouter?: FieldRouter;

  private readonly invoker: CombinedInvoker;

  constructor(invokers: BindingInvoker[], opts?: OperationInvokerOptions) {
    this.bindingSelector = opts?.bindingSelector;
    this.transformEvaluator = opts?.transformEvaluator;
    this.contextResolver = opts?.contextResolver;
    this.fetch = opts?.fetch;
    this.outputDecoder = opts?.outputDecoder;
    this.resultClassifier = opts?.resultClassifier;
    this.fieldRouter = opts?.fieldRouter;
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
      // Hook fields ride the copy (the Go SDK's struct-copy semantics).
      outputDecoder: this.outputDecoder,
      resultClassifier: this.resultClassifier,
      fieldRouter: this.fieldRouter,
    });
    // Share the underlying combined-invoker registry rather than re-combining
    // (which would lose any invokers added via addBindingInvoker on the source).
    (cp as unknown as { invoker: CombinedInvoker }).invoker = this.invoker;
    return cp;
  }

  /**
   * Composes per-invocation hooks over this invoker's invoker-level hooks
   * into the seam carrier a direct binding-layer call passes as
   * `args.hooks` — the same both-tier snapshot `invoke` takes at entry.
   * Undefined axes simply decline down the chain (per-invocation →
   * invoker-level → builtin). Null when both tiers are empty.
   */
  snapshotHooks(
    decode?: OutputDecoder,
    classify?: ResultClassifier,
    route?: FieldRouter,
  ): InvokeHooks | null {
    return newInvokeHooks(
      { decode, classify, route },
      { decode: this.outputDecoder, classify: this.resultClassifier, route: this.fieldRouter },
    );
  }

  /**
   * All formats registered with this invoker. An aggregation convenience
   * over the registered binding invokers; the operation-invoker interface itself
   * carries no listFormats operation (its format reach is dynamic, e.g. via
   * delegates).
   */
  formats(): FormatInfo[] {
    return this.invoker.formats();
  }

  private availableFormats(): Set<string> {
    return new Set(this.invoker.formats().map(f => f.token));
  }

  /**
   * Binding-layer passthrough: invoke a resolved binding directly, without
   * operation-layer validation, transforms, or context negotiation. The
   * seam carrier and a site are filled from the invoker level when the
   * caller supplied none — this is what makes an embedder's invoker-level
   * hook table reach direct binding-layer invocations. Direct callers who
   * want different hooks pass their own (see snapshotHooks).
   */
  invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
    return this.invoker.invokeBinding<I, O>(this.withFetch(this.fillBindingArgs(args)));
  }

  /** Completes a binding-layer call's args with the seam carrier and a site. Never mutates the caller's args. */
  private fillBindingArgs(args: BindingInvocationArgs): BindingInvocationArgs {
    if (args.hooks !== undefined && args.site !== undefined) return args;
    const filled = { ...args };
    if (filled.hooks === undefined) filled.hooks = this.snapshotHooks();
    if (filled.site === undefined) {
      filled.site = {
        operation: args.binding?.operation ?? "",
        invokedAs: args.binding?.operation ?? "",
        bindingKey: "",
        format: args.source.format,
        ref: args.ref,
        target: "",
      };
    }
    return filled;
  }

  /** Side-effect-free preflight for a resolved binding (binding-invoker interface `prepareBinding`). */
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
  invoke<I = unknown, O = unknown>(
    obi: OBInterface,
    sig: OperationSignature<I, O>,
    opts?: InvokeOptions,
  ): Invocation<I, O> {
    const { op, opKey, bindingKey, binding, source } = this.resolveBinding(obi, sig.key, opts?.bindingKey, opts?.context);

    const callerInv = new InvocationImpl<I, O>({
      signal: opts?.signal,
      validateInput: makeInputValidator(op, obi, sig.key),
    });

    // Both hook tiers snapshot at invoke entry ("resolved once" = immunity
    // to later field mutation; precedence applies at consultation time by
    // decline-chaining).
    const hooks = this.snapshotHooks(opts?.outputDecoder, opts?.resultClassifier, opts?.fieldRouter);
    const site: InvokeSite = {
      operation: opKey,
      invokedAs: sig.key,
      bindingKey,
      format: source.format,
      ref: binding.ref ?? "",
      target: "",
    };

    queueMicrotask(() => {
      this.run(callerInv, obi, op, binding, bindingKey, source, opts?.context, hooks, site).catch((err) => {
        callerInv.fireError(asInvocationError(err));
      });
    });

    return callerInv;
  }

  /**
   * Operation-layer side-effect-free preflight (the operation-invoker interface
   * `prepareOperation`), the by-reference counterpart to `prepareBinding`. It
   * resolves `operation` on `obi` to a concrete binding (OBI-T-12 resolution +
   * contract-default selection or the context.configuration.selection override
   * selection, or an `opts.bindingKey`-pinned binding) and reports that
   * binding's context requirements without invoking or causing side effects.
   * Resolves to null when requirements cannot be determined without invoking
   * (the always-satisfiable answer); `opts.context` narrows the result to what
   * it leaves unsatisfied. Composes the resolution with `prepareBinding` so
   * callers preflight by operation without selecting a binding themselves.
   */
  prepareOperation(
    obi: OBInterface,
    operation: string,
    opts?: InvokeOptions,
  ): Promise<ContextRequiredDetails | null> {
    const { op, binding, source } = this.resolveBinding(obi, operation, opts?.bindingKey, opts?.context);
    return this.prepareBinding({
      source: {
        format: source.format,
        location: source.location,
        ...(source.content != null ? { content: source.content } : {}),
      },
      ref: binding.ref ?? "",
      binding,
      inputSchema: op.input ?? undefined,
      interface: obi,
      context: opts?.context,
    });
  }

  /**
   * Shared operation-layer resolution behind {@link invoke} and
   * {@link prepareOperation}: resolves `operation` against obi's flat key+alias
   * namespace (OBI-T-12), selects a binding (the contract's default policy,
   * displaced by a context.configuration.selection override or the
   * caller-pinned `bindingKey`), and looks up its source. Throws synchronously
   * on a wiring failure (unknown operation, binding, or source).
   */
  private resolveBinding(
    obi: OBInterface,
    operation: string,
    pinnedBindingKey?: string,
    callerContext?: Record<string, unknown>,
  ): { op: Operation; opKey: string; bindingKey: string; binding: BindingEntry; source: Source } {
    const iface = obi;
    if (!iface) throw new MissingInterfaceError();

    const resolved = resolveOperation(iface, operation);
    if (!resolved) {
      throw new OperationNotFoundError(operation, allOperationIdentifiers(iface));
    }
    const { key: opKey, operation: op } = resolved;

    // A pinned bindingKey narrows selection to one binding OF the resolved
    // operation; it never replaces the operation. Addressing a binding *without*
    // an operation (the contract's binding-alone form, which derives the
    // operation) is a wire/dynamic concern — a caller with only a key does
    // obi.bindings[key].operation and passes it here — so the native API stays
    // operation-keyed.
    let bindingKey: string;
    let binding: BindingEntry;
    if (pinnedBindingKey) {
      const b = iface.bindings?.[pinnedBindingKey];
      if (!b) throw new BindingNotFoundError(pinnedBindingKey);
      // The explicit binding must name a binding FOR the resolved operation.
      // Otherwise a caller could invoke any binding under the guise of any
      // operation, applying the wrong operation's schemas and transforms.
      if (b.operation !== opKey) throw new BindingNotFoundError(opKey);
      bindingKey = pinnedBindingKey;
      binding = b;
    } else {
      // The operation-invoker contract's consumer override
      // (context.configuration.selection): an ordered list of binding keys,
      // the first invocable entry winning. It displaces whatever selection
      // policy is in place; when no listed key is invocable, the policy
      // applies.
      const overridden = selectionOverride(
        iface,
        opKey,
        contextSelectionOverride(callerContext),
        this.availableFormats(),
      );
      if (overridden) {
        ({ key: bindingKey, binding } = overridden);
      } else {
        const selector = this.bindingSelector ?? ((i: OBInterface, o: string) =>
          defaultBindingSelector(i, o, this.availableFormats()));
        ({ key: bindingKey, binding } = selector(iface, opKey));
      }
    }

    const source = iface.sources?.[binding.source];
    if (!source) throw new UnknownSourceError(bindingKey, binding.source);

    return { op, opKey, bindingKey, binding, source };
  }

  /**
   * Drives the binding-layer invocation(s) behind one caller-facing handle:
   * an input pump forwarding (transformed) caller inputs, an output loop
   * forwarding (transformed, schema-validated) binding outputs, and the
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
    hooks: InvokeHooks | null = null,
    site?: InvokeSite,
  ): Promise<void> {
    const evaluator = this.transformEvaluator;
    if ((binding.inputTransform || binding.outputTransform) && !evaluator) {
      callerInv.fireError(
        new InvocationError(ERR_TRANSFORM_ERROR, new NoTransformEvaluatorError(bindingKey).message),
      );
      return;
    }

    // Compile the output schema once per invocation, over the complete
    // statically reachable schema graph (every document schema rides as
    // $defs). A graph that cannot be established is ERR_SCHEMA_UNRESOLVED —
    // the claim could not be evaluated — never partial validation
    // (OBI-T-16).
    let outputValidator: CompiledSchema | undefined;
    if (op.output != null) {
      try {
        outputValidator = compileExampleSchema(op.output, buildSchemaDefs(iface.schemas));
      } catch (err) {
        callerInv.fireError(
          new InvocationError(
            ERR_SCHEMA_UNRESOLVED,
            `openbindings: output schema graph for "${bindingKey}" could not be established: ${(err as Error).message}`,
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
        hooks,
        ...(site ? { site } : {}),
      });

    const mergeResolved = (resolved: Record<string, unknown>): void => {
      context = { ...(context ?? {}), ...resolved };
    };

    // Preflight (binding-invoker interface `prepareBinding`): collapse
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
              let msg = `openbindings: output validation failed for "${bindingKey}": ${r.errors.join("; ")}`;
              // Contract-decided teaching + decode-lane provenance in the
              // MESSAGE, not only the x-ob-decode trailer stamp (mirrors
              // the Go SDK): a hook-decoded value failing a floor-stamped
              // schema means the CONTRACT still declares the floor; any
              // other mismatch may be a wrong decode lane, and the
              // first-touch reader needs the pointer where they look.
              const tier = hooks?.decodeDecidedBy() ?? "";
              if (floorStamped(op.output) && tier === "hook") {
                msg +=
                  " — the synthesized schema still declares the floor's string; elect the real output schema (a stored output-schema election on the operation)";
              } else if (tier !== "") {
                msg += ` (the response was decoded as ${describeDecodeTier(tier)}; if the service actually returned a different shape — say JSON without a Content-Type header — this mismatch is the symptom, and the fix is the response's declared type or a custom OutputDecoder)`;
              }
              surface = new InvocationError(ERR_VALIDATION_FAILED, msg, { failures: r.failures });
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
        const t = terminalTrailer(inner) ?? {};
        // Per the conventions record's recommended built-in defaults
        // (spec/formats/README.md): the unvalidated-assumption warning
        // rides the trailer on SUCCESS only (failures carry tier-precise
        // provenance already), keyed on the format's own decode stamp —
        // only an assumption lane can trigger it.
        if (!surface) {
          const w = assumptionWarning(t["x-ob-decode"]?.[0] ?? "", op.output);
          if (w) t["x-ob-warning"] = [...(t["x-ob-warning"] ?? []), w];
        }
        if (Object.keys(t).length > 0) callerInv.setTrailer(t);
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

/**
 * Builds the write-validation hook for an operation, compiling lazily on
 * first write. Validation carries the core's claim semantics (OBI-T-16):
 * the complete statically reachable schema graph, `format` as annotation,
 * applied per value — a mismatch is ERR_VALIDATION_FAILED; a graph that
 * cannot be established is ERR_SCHEMA_UNRESOLVED, never partial validation.
 */
function makeInputValidator(
  op: Operation,
  iface: OBInterface,
  operationName: string,
): ((input: unknown) => InvocationError | null) | undefined {
  if (op.input == null) return undefined;
  let validator: CompiledSchema | undefined;
  let compileError: InvocationError | undefined;
  let compiled = false;
  return (input: unknown): InvocationError | null => {
    if (!compiled) {
      compiled = true;
      try {
        validator = compileExampleSchema(op.input!, buildSchemaDefs(iface.schemas));
      } catch (err) {
        compileError = new InvocationError(
          ERR_SCHEMA_UNRESOLVED,
          `openbindings: input schema graph for "${operationName}" could not be established: ${(err as Error).message}`,
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

/**
 * Renders a decode tier for a first-touch error message: the seam's internal
 * names ("builtin", "hook") become plain descriptions. Mirrors the Go SDK's
 * describeDecodeTier.
 */
function describeDecodeTier(tier: string): string {
  switch (tier) {
    case "builtin":
      return "the format's default rule";
    case "hook":
      return "your custom OutputDecoder";
    default:
      return tier;
  }
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
 * Resolves the operation-invoker contract's context.configuration.selection
 * override: the first listed binding key that is invocable — defined on the
 * interface, targeting the resolved operation, and (when availableFormats is
 * provided) governed by a specification the invoker can act on — wins.
 * Returns null when no listed key is invocable, in which case the selection
 * policy applies.
 */
function selectionOverride(
  iface: OBInterface,
  opKey: string,
  keys: string[],
  availableFormats?: Set<string>,
): { key: string; binding: BindingEntry } | null {
  for (const k of keys) {
    const b = iface.bindings?.[k];
    if (!b || b.operation !== opKey) continue;
    if (availableFormats) {
      const source = iface.sources?.[b.source];
      if (source && !formatMatches(source.format, availableFormats)) continue;
    }
    return { key: k, binding: b };
  }
  return null;
}

/**
 * Extracts the operation-invoker contract's `selection` configuration point
 * from context: an ordered list of binding keys. Anything that is not an
 * array of strings is no override.
 */
function contextSelectionOverride(ctx: Record<string, unknown> | null | undefined): string[] {
  const raw = contextConfiguration(ctx)["selection"];
  if (!Array.isArray(raw) || !raw.every((e) => typeof e === "string")) return [];
  return raw as string[];
}

/**
 * Picks the best binding for an operation, by the operation-invoker
 * contract's normative default policy: non-deprecated candidates rank before
 * deprecated ones; within a tier, higher declared `preference` ranks first,
 * and a candidate with no declared preference ranks below every candidate
 * with one; remaining ties break by lexicographic binding key. Preference is
 * the binding's own — the core defines no source-level preference and
 * nothing is inherited. When availableFormats is provided, bindings whose
 * source format is not in the set are skipped.
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
  let bestDeclared = false;
  let bestDeprecated = true;
  // Bindings that matched the operation but were skipped because no registered
  // invoker handles their source format. The distinction is load-bearing for
  // the error: "the document has no binding" sends the reader to audit the
  // OBI; "the binding needs a format you didn't register" sends them to their
  // own OperationInvoker construction.
  const formatSkipped = new Map<string, string>(); // binding key -> required format

  for (const [k, b] of Object.entries(iface.bindings)) {
    if (b.operation !== opKey) continue;

    const source = iface.sources?.[b.source];

    // Skip bindings whose source format the invoker can't handle.
    if (availableFormats && source && !formatMatches(source.format, availableFormats)) {
      formatSkipped.set(k, source.format);
      continue;
    }

    // The ruled default policy: a candidate with no declared preference
    // ranks below every candidate with one (a declared negative beats
    // undeclared). Preference is the binding's own; the core defines no
    // source-level preference and nothing is inherited.
    const declared = b.preference != null;
    const bPref = declared ? b.preference! : -Infinity;

    const betterDeprecation = bestDeprecated && !b.deprecated;
    const sameTier = (b.deprecated ?? false) === bestDeprecated;
    const betterPref =
      (declared !== bestDeclared && declared) || (declared === bestDeclared && bPref > bestPref);
    const samePref = declared === bestDeclared && bPref === bestPref;

    if (
      !best ||
      betterDeprecation ||
      (sameTier && betterPref) ||
      (sameTier && samePref && k < bestKey!)
    ) {
      bestKey = k;
      best = b;
      bestPref = bPref;
      bestDeclared = declared;
      bestDeprecated = b.deprecated ?? false;
    }
  }

  if (!best || !bestKey) {
    if (formatSkipped.size > 0) {
      const needs = [...formatSkipped.keys()]
        .sort()
        .map((k) => `"${k}" requires format ${formatSkipped.get(k)}`)
        .join(", ");
      const registered = availableFormats ? [...availableFormats].sort().join(", ") : "";
      throw new BindingNotFoundError(
        opKey,
        `binding ${needs}; registered invoker formats: [${registered}] (did you register the format's invoker in the OperationInvoker constructor?)`,
      );
    }
    throw new BindingNotFoundError(opKey);
  }
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

import type { OBInterface, BindingEntry, Operation, Source, Transform, TransformOrRef, BindingSpecInfo, BindingSpecVerdict } from "@openbindings/core";
import { PreparedInterface, prepareInterface, resolveTransform } from "@openbindings/core";
import type {
  BindingInvocationArgs,
  InvokeOptions,
} from "./invoker-types.js";
import type { OperationSignature } from "./operation-signature.js";
import type {
  BindingInvoker,
  BindingSelector,
  ContextResolver,
  CompiledBindingInvoker,
  TransformEvaluator,
} from "./invokers.js";
import {
  type ContextRequiredDetails,
  type BindingHandle,
  type Invocation,
  InvocationError,
  InvocationImpl,
  contextRequiredError,
  isContextRequired,
  isContextRequiredDetails,
} from "./invocation.js";
import { OperationNotFoundError, ValidationError } from "@openbindings/core";
import {
  BindingNotFoundError,
  BindingSelectionRequiredError,
  EmptyTransformExpressionError,
  MissingInterfaceError,
  NoInvokerError,
  TransformRefNotFoundError,
  UnknownSourceError,
} from "./errors.js";
import { combineInvokers, type CombinedInvoker } from "./combiners.js";
import { contextConfiguration } from "./context.js";
import { resolveOperation, allOperationIdentifiers } from "@openbindings/core";
import {
  ERR_BINDING_NOT_FOUND,
  ERR_SCHEMA_UNRESOLVED,
  ERR_INPUT_CLOSED,
  ERR_RUNTIME,
  ERR_TOO_MANY_INPUTS,
  ERR_TRANSFORM_ERROR,
  ERR_OPERATION_VALIDATION_FAILED,
} from "./errcodes.js";
import { compileOperationSchema, safeValidate, type CompiledSchema } from "@openbindings/core";
import {
  type FieldRouter,
  type InvokeHooks,
  type InvokeSite,
  type OutputDecoder,
  type ResultClassifier,
  newInvokeHooks,
} from "./hooks.js";
import type { DiagnosticCollector } from "./diagnostics.js";

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
   * Bounds ONE DELIVERY UNIT — the bytes materialized to produce one
   * emitted output value — for every invocation this invoker drives.
   * Undefined or `<= 0` selects the default
   * (`DEFAULT_MAX_DELIVERY_UNIT_BYTES`). Effectively-unlimited = set
   * explicitly huge (no magic sentinel). Stamped into per-invocation
   * `BindingInvocationArgs` exactly where `fetch` is; args that already
   * carry a value win.
   */
  maxDeliveryUnitBytes?: number;
  /**
   * Invoker-level consumer hooks (specification + configuration = complete
   * invocation): consulted after any per-invocation hook declines, before
   * the format built-in. Site-guard your hook bodies (site.operation,
   * siteFamilyName) when the invoker serves multiple interfaces.
   */
  outputDecoder?: OutputDecoder;
  resultClassifier?: ResultClassifier;
  fieldRouter?: FieldRouter;
}

/** Per-call options for an operation whose exact binding is already prepared. */
export type PreparedInvokeOptions = Omit<InvokeOptions, "bindingKey">;
/** Live preflight inputs; invocation-only output hooks cannot be supplied. */
export type PreparedPreflightOptions = Pick<InvokeOptions, "context" | "signal">;

/**
 * An immutable, executable snapshot of one exact operation binding.
 *
 * Preparation resolves the operation and binding, deep-snapshots the OBI,
 * compiles both operation schemas, and performs side-effect-free preflight.
 * Repeated invocation therefore performs no document cloning, binding
 * selection, or schema compilation and cannot drift when the caller later
 * mutates its original OBI object.
 */
export interface PreparedOperation<I = unknown, O = unknown> {
  readonly interfaceSnapshot: OBInterface;
  readonly signature: OperationSignature<I, O>;
  readonly canonicalOperation: string;
  readonly bindingKey: string;
  readonly bindingSpec: string;
  readonly knownContextRequirements: ContextRequiredDetails | null;
  invoke(options?: PreparedInvokeOptions): Invocation<I, O>;
  prepare(options?: PreparedPreflightOptions): Promise<ContextRequiredDetails | null>;
}

/**
 * A statically closed operation realization. Unlike the transitional
 * PreparedOperation, it carries no timeless claim about live context: callers
 * preflight explicitly when they need a current answer.
 */
export interface CompiledOperation<I = unknown, O = unknown> {
  readonly preparedInterface: PreparedInterface;
  readonly signature: OperationSignature<I, O>;
  readonly canonicalOperation: string;
  readonly bindingKey: string;
  readonly bindingSpec: string;
  invoke(options?: PreparedInvokeOptions): Invocation<I, O>;
  preflight(options?: PreparedPreflightOptions): Promise<ContextRequiredDetails | null>;
}

interface PreparedOperationState<I, O> {
  readonly preparedInterface: PreparedInterface;
  readonly iface: OBInterface;
  readonly signature: OperationSignature<I, O>;
  readonly op: Operation;
  readonly opKey: string;
  readonly bindingKey: string;
  readonly binding: BindingEntry;
  readonly source: Source;
  readonly inputValidator?: CompiledSchema;
  readonly outputValidator?: CompiledSchema;
  readonly compiledBinding: CompiledBindingInvoker;
}

/**
 * The operation-layer invoker: resolves an OBI operation to a binding
 * (OBI-T-12 name resolution; explicit caller choice or the
 * operation-invoker contract's sole-candidate rule)
 * and returns a
 * cardinality-agnostic {@link Invocation} handle.
 *
 * Between the caller and the binding it enforces the operation contract:
 * (validation carries the core's claim semantics, OBI-T-16: complete
 * statically reachable schema graph, `format` as annotation, per value; a
 * mismatch is ERR_OPERATION_VALIDATION_FAILED, an unresolvable governing graph is
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
  readonly maxDeliveryUnitBytes?: number;
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
    this.maxDeliveryUnitBytes = opts?.maxDeliveryUnitBytes;
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
      maxDeliveryUnitBytes: this.maxDeliveryUnitBytes,
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
   * All binding specifications registered with this invoker, by exact
   * identifier. An aggregation convenience over the registered binding
   * invokers; the operation-invoker interface itself carries no
   * listBindingSpecs operation (its reach is dynamic, e.g. via delegates).
   */
  bindingSpecs(): BindingSpecInfo[] {
    return this.invoker.bindingSpecs();
  }

  /** Authoritatively checks exact binding-specification support. */
  checkBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
    return this.invoker.checkBindingSpecs(bindingSpecs);
  }

  private availableBindingSpecs(iface: OBInterface, opKey: string): Set<string> {
    const candidates = new Set<string>();
    for (const binding of Object.values(iface.bindings ?? {})) {
      if (binding.operation !== opKey) continue;
      const source = iface.sources?.[binding.source];
      if (source) candidates.add(source.bindingSpec);
    }
    const requested = [...candidates].sort();
    return new Set(
      this.invoker.checkBindingSpecs(requested)
        .filter(({ supported }) => supported)
        .map(({ bindingSpec }) => bindingSpec),
    );
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
        bindingSpec: args.source.bindingSpec,
        selector: args.selector,
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
      validateInput: makeInputValidator(op, obi, opKey, bindingKey, opts?.diagnostics),
    });

    // Both hook tiers snapshot at invoke entry ("resolved once" = immunity
    // to later field mutation; precedence applies at consultation time by
    // decline-chaining).
    const hooks = this.snapshotHooks(opts?.outputDecoder, opts?.resultClassifier, opts?.fieldRouter);
    const site: InvokeSite = {
      operation: opKey,
      invokedAs: sig.key,
      bindingKey,
      bindingSpec: source.bindingSpec,
      selector: binding.selector ?? "",
      target: "",
    };

    queueMicrotask(() => {
      this.run(callerInv, obi, op, binding, bindingKey, source, opts?.context, hooks, site, undefined, false, undefined, opts?.diagnostics).catch((err) => {
        callerInv.fireError(asInvocationError(err));
      });
    });

    return callerInv;
  }

  /**
   * Resolves and freezes one exact executable operation realization.
   *
   * Unlike {@link prepareOperation}, this returns a reusable handle rather
   * than only context requirements. The caller's OBI is cloned, never frozen
   * in place. Schema compilation and binding selection happen here, making a
   * prepared handle the safe application-wiring artifact for repeated calls.
   */
  async prepareOperationHandle<I = unknown, O = unknown>(
    obi: OBInterface | PreparedInterface,
    signature: OperationSignature<I, O>,
    opts?: InvokeOptions,
  ): Promise<PreparedOperation<I, O>> {
    let preparedInterface: PreparedInterface;
    try {
      preparedInterface = await prepareInterface(obi);
    } catch (error: unknown) {
      // Preserve the transitional API's invocation-layer classification for
      // a governing graph that cannot be established. Direct
      // prepareInterface callers retain the richer Core validation failure.
      if (
        error instanceof ValidationError &&
        error.problems.some(problem => problem.includes("(OBI-D-16)") || problem.includes("(OBI-D-17)"))
      ) {
        throw new InvocationError(ERR_SCHEMA_UNRESOLVED);
      }
      throw error;
    }
    const compiled = this.compileOperationHandle(preparedInterface, signature, opts);
    const known = await compiled.preflight(opts);
    if (known !== null && !isContextRequiredDetails(known)) {
      throw new InvocationError(ERR_RUNTIME);
    }
    const knownContextRequirements = known === null
      ? null
      : immutableValueSnapshot(known);

    return Object.freeze({
      interfaceSnapshot: preparedInterface.interfaceSnapshot,
      signature: compiled.signature,
      canonicalOperation: compiled.canonicalOperation,
      bindingKey: compiled.bindingKey,
      bindingSpec: compiled.bindingSpec,
      knownContextRequirements,
      invoke: (options?: PreparedInvokeOptions): Invocation<I, O> =>
        compiled.invoke(options),
      prepare: (options?: PreparedPreflightOptions): Promise<ContextRequiredDetails | null> =>
        compiled.preflight(options),
    });
  }

  /**
   * Closes one exact operation/binding realization against an already
   * prepared interface. This performs every deterministic check once and no
   * live preflight. The returned closure shares the interface snapshot and
   * compiled validators with every other realization from that preparation.
   */
  compileOperationHandle<I = unknown, O = unknown>(
    preparedInterface: PreparedInterface,
    signature: OperationSignature<I, O>,
    opts?: InvokeOptions,
  ): CompiledOperation<I, O> {
    if (!(preparedInterface instanceof PreparedInterface)) {
      throw new TypeError("openbindings: a PreparedInterface is required");
    }
    const iface = preparedInterface.interfaceSnapshot;
    const resolved = this.resolveBinding(
      iface,
      signature.key,
      opts?.bindingKey,
      opts?.context,
    );

    if ((resolved.binding.inputTransform || resolved.binding.outputTransform) && !this.transformEvaluator) {
      throw new InvocationError(ERR_TRANSFORM_ERROR);
    }
    if (!this.availableBindingSpecs(iface, resolved.opKey).has(resolved.source.bindingSpec)) {
      throw new NoInvokerError(resolved.source.bindingSpec);
    }

    let inputValidator: CompiledSchema | undefined;
    let outputValidator: CompiledSchema | undefined;
    try {
      if (resolved.op.input != null) {
        inputValidator = preparedInterface.schemaValidator(resolved.opKey, "input");
      }
      if (resolved.op.output != null) {
        outputValidator = preparedInterface.schemaValidator(resolved.opKey, "output");
      }
    } catch {
      throw new InvocationError(ERR_SCHEMA_UNRESOLVED);
    }

    const preparedSignature: OperationSignature<I, O> = Object.freeze({
      key: signature.key,
    });
    const state: PreparedOperationState<I, O> = {
      preparedInterface,
      iface,
      signature: preparedSignature,
      op: resolved.op,
      opKey: resolved.opKey,
      bindingKey: resolved.bindingKey,
      binding: resolved.binding,
      source: resolved.source,
      inputValidator,
      outputValidator,
      compiledBinding: this.invoker.compileBinding(this.withFetch({
        source: {
          bindingSpec: resolved.source.bindingSpec,
          location: resolved.source.location,
          ...(resolved.source.content !== undefined
            ? { content: resolved.source.content }
            : {}),
        },
        selector: resolved.binding.selector ?? "",
        binding: resolved.binding,
        inputSchema: resolved.op.input ?? undefined,
        interface: iface,
        context: opts?.context,
        signal: opts?.signal,
      })),
    };
    return Object.freeze({
      preparedInterface,
      signature: state.signature,
      canonicalOperation: state.opKey,
      bindingKey: state.bindingKey,
      bindingSpec: state.source.bindingSpec,
      invoke: (options?: PreparedInvokeOptions): Invocation<I, O> =>
        this.invokePreparedOperation(state, options),
      preflight: (options?: PreparedPreflightOptions): Promise<ContextRequiredDetails | null> =>
        this.prepareResolvedOperation(state, options),
    });
  }

  /**
   * Operation-layer side-effect-free preflight (the operation-invoker interface
   * `prepareOperation`), the by-reference counterpart to `prepareBinding`. It
   * resolves `operation` on `obi` to a concrete binding (OBI-T-12 resolution +
   * explicit selection or the sole-candidate rule) and reports that
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
        bindingSpec: source.bindingSpec,
        location: source.location,
        // content: null is a PRESENT member (core presence rule) and must
        // flow to the family as a value — only undefined means absent.
        ...(source.content !== undefined ? { content: source.content } : {}),
      },
      selector: binding.selector ?? "",
      binding,
      inputSchema: op.input ?? undefined,
      interface: obi,
      context: opts?.context,
      signal: opts?.signal,
    });
  }

  private prepareResolvedOperation<I, O>(
    prepared: PreparedOperationState<I, O>,
    opts?: PreparedPreflightOptions,
  ): Promise<ContextRequiredDetails | null> {
    return this.prepareBinding({
      source: {
        bindingSpec: prepared.source.bindingSpec,
        location: prepared.source.location,
        ...(prepared.source.content !== undefined
          ? { content: prepared.source.content }
          : {}),
      },
      selector: prepared.binding.selector ?? "",
      binding: prepared.binding,
      inputSchema: prepared.op.input ?? undefined,
      interface: prepared.iface,
      context: opts?.context,
      signal: opts?.signal,
    });
  }

  private invokePreparedOperation<I, O>(
    prepared: PreparedOperationState<I, O>,
    opts?: PreparedInvokeOptions,
  ): Invocation<I, O> {
    const callerInv = new InvocationImpl<I, O>({
      signal: opts?.signal,
      validateInput: validatorHook(
        prepared.inputValidator,
        prepared.opKey,
        prepared.bindingKey,
        opts?.diagnostics,
      ),
    });
    const hooks = this.snapshotHooks(
      opts?.outputDecoder,
      opts?.resultClassifier,
      opts?.fieldRouter,
    );
    const site: InvokeSite = {
      operation: prepared.opKey,
      invokedAs: prepared.signature.key,
      bindingKey: prepared.bindingKey,
      bindingSpec: prepared.source.bindingSpec,
      selector: prepared.binding.selector ?? "",
      target: "",
    };

    const directBinding = prepared.compiledBinding.invokeBindingHandle === undefined
      ? undefined
      : (handle: BindingHandle<unknown, unknown>, args: BindingInvocationArgs) =>
        prepared.compiledBinding.invokeBindingHandle!(handle, args);
    if (directBinding && !this.contextResolver) {
      const args = this.preparedBindingArgs(
        prepared,
        opts?.context,
        callerInv.signal,
        hooks,
        site,
      );
      const handle = this.operationBoundaryHandle(
        callerInv,
        prepared,
        opts?.diagnostics,
      );
      queueMicrotask(() => {
        this.runDirectPreparedBinding(
          callerInv,
          handle,
          prepared.compiledBinding,
          directBinding,
          args,
        ).catch(error => callerInv.fireError(asInvocationError(error)));
      });
      return callerInv;
    }

    queueMicrotask(() => {
      this.run(
        callerInv,
        prepared.iface,
        prepared.op,
        prepared.binding,
        prepared.bindingKey,
        prepared.source,
        opts?.context,
        hooks,
        site,
        prepared.outputValidator,
        true,
        prepared.compiledBinding,
        opts?.diagnostics,
      ).catch((err) => callerInv.fireError(asInvocationError(err)));
    });
    return callerInv;
  }

  /** Builds the immutable/static and per-call/dynamic binding arguments once. */
  private preparedBindingArgs<I, O>(
    prepared: PreparedOperationState<I, O>,
    context: Record<string, unknown> | undefined,
    signal: AbortSignal,
    hooks: InvokeHooks | null,
    site: InvokeSite,
  ): BindingInvocationArgs {
    return this.withFetch({
      source: {
        bindingSpec: prepared.source.bindingSpec,
        location: prepared.source.location,
        ...(prepared.source.content !== undefined
          ? { content: prepared.source.content }
          : {}),
      },
      selector: prepared.binding.selector ?? "",
      binding: prepared.binding,
      inputSchema: prepared.op.input ?? undefined,
      interface: prepared.iface,
      context,
      signal,
      hooks,
      site,
    });
  }

  /**
   * Runs a captured in-process binding against the caller's invocation
   * channel directly. Deterministic preflight remains once per attempt; no
   * registry lookup, second InvocationImpl, pump, replay log, or JSON bridge
   * exists on this path.
   */
  private async runDirectPreparedBinding<I, O>(
    callerInv: InvocationImpl<I, O>,
    handle: BindingHandle<unknown, unknown>,
    compiledBinding: CompiledBindingInvoker,
    invokeBindingHandle: NonNullable<CompiledBindingInvoker["invokeBindingHandle"]>,
    args: BindingInvocationArgs,
  ): Promise<void> {
    if (callerInv.signal.aborted) return;
    let details: ContextRequiredDetails | null;
    try {
      details = await compiledBinding.prepareBinding(args);
    } catch (error: unknown) {
      callerInv.fireError(wireError(error));
      return;
    }
    if (details !== null) {
      callerInv.fireError(
        isContextRequiredDetails(details)
          ? contextRequiredError(details)
          : new InvocationError(ERR_RUNTIME),
      );
      return;
    }
    if (callerInv.signal.aborted) return;
    await invokeBindingHandle(handle, args);
  }

  /** Applies operation transforms/output validation around one native handle. */
  private operationBoundaryHandle<I, O>(
    callerInv: InvocationImpl<I, O>,
    prepared: PreparedOperationState<I, O>,
    diagnostics?: DiagnosticCollector,
  ): BindingHandle<unknown, unknown> {
    const evaluator = this.transformEvaluator;
    const inputTransform = prepared.binding.inputTransform;
    const outputTransform = prepared.binding.outputTransform;
    const outputValidator = prepared.outputValidator;

    if (!inputTransform && !outputTransform && !outputValidator) {
      return callerInv;
    }

    return {
      inputs: (): AsyncIterable<unknown> => {
        const source = callerInv.inputs();
        if (!inputTransform) return source;
        return {
          [Symbol.asyncIterator](): AsyncIterator<unknown> {
            const iterator = source[Symbol.asyncIterator]();
            return {
              async next(): Promise<IteratorResult<unknown, void>> {
                const item = await iterator.next();
                if (item.done) return item;
                try {
                  const value = await applyTransformRef(
                    evaluator!,
                    prepared.iface.transforms,
                    inputTransform,
                    item.value,
                  );
                  return { value, done: false };
                } catch {
                  const error = new InvocationError(ERR_TRANSFORM_ERROR);
                  callerInv.fireError(error);
                  throw error;
                }
              },
              ...(iterator.return === undefined
                ? {}
                : { return: (value?: void) => iterator.return!(value) }),
              ...(iterator.throw === undefined
                ? {}
                : { throw: (error?: unknown) => iterator.throw!(error) }),
            };
          },
        };
      },
      closeInput: () => callerInv.closeInput(),
      emitOutput: async (raw: unknown): Promise<void> => {
        let output = raw;
        if (outputTransform) {
          try {
            output = await applyTransformRef(
              evaluator!,
              prepared.iface.transforms,
              outputTransform,
              output,
            );
          } catch {
            const error = new InvocationError(ERR_TRANSFORM_ERROR);
            callerInv.fireError(error);
            throw error;
          }
        }
        if (outputValidator) {
          const result = safeValidate(outputValidator, output);
          if (!result.valid) {
            diagnostics?.recordValidation(
              "output",
              prepared.opKey,
              prepared.bindingKey,
              result.failures,
            );
            const error = new InvocationError(ERR_OPERATION_VALIDATION_FAILED);
            callerInv.fireError(error);
            throw error;
          }
        }
        await callerInv.emitOutput(output as O);
      },
      closeOutput: () => callerInv.closeOutput(),
      fireError: error => callerInv.fireError(error),
      get signal(): AbortSignal {
        return callerInv.signal;
      },
    };
  }

  /**
   * Shared operation-layer resolution behind {@link invoke} and
   * {@link prepareOperation}: resolves `operation` against obi's flat key+alias
   * namespace (OBI-T-12), resolves a binding (an explicit caller choice or the
   * contract's sole-candidate rule), and looks up its source. Throws synchronously
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
      const bindings = iface.bindings;
      const b =
        bindings && Object.hasOwn(bindings, pinnedBindingKey)
          ? bindings[pinnedBindingKey]
          : undefined;
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
      // policy is in place. When no listed key is invocable, the
      // policy-neutral sole-candidate/ambiguity rule applies.
      const availableBindingSpecs = this.availableBindingSpecs(iface, opKey);
      const overridden = selectionOverride(
        iface,
        opKey,
        contextSelectionOverride(callerContext),
        availableBindingSpecs,
      );
      if (overridden) {
        ({ key: bindingKey, binding } = overridden);
      } else {
        const selector = this.bindingSelector ?? ((i: OBInterface, o: string) =>
          defaultBindingSelector(i, o, availableBindingSpecs));
        ({ key: bindingKey, binding } = selector(iface, opKey));
      }
    }

    const sources = iface.sources;
    const source =
      sources && Object.hasOwn(sources, binding.source)
        ? sources[binding.source]
        : undefined;
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
    preparedOutputValidator?: CompiledSchema,
    outputAlreadyCompiled = false,
    compiledBinding?: CompiledBindingInvoker,
    diagnostics?: DiagnosticCollector,
  ): Promise<void> {
    const evaluator = this.transformEvaluator;
    if ((binding.inputTransform || binding.outputTransform) && !evaluator) {
      callerInv.fireError(
        new InvocationError(ERR_TRANSFORM_ERROR),
      );
      return;
    }

    // Compile the output schema once per invocation at its canonical address
    // inside the OBI document, preserving the complete statically reachable
    // schema graph. A graph that cannot be established is ERR_SCHEMA_UNRESOLVED —
    // the claim could not be evaluated — never partial validation
    // (OBI-T-16).
    let outputValidator = preparedOutputValidator;
    if (!outputAlreadyCompiled && op.output != null) {
      try {
        outputValidator = compileOperationSchema(iface, binding.operation, "output");
      } catch {
        callerInv.fireError(
          new InvocationError(ERR_SCHEMA_UNRESOLVED),
        );
        return;
      }
    }

    let context = initialContext;
    const bindingArgs = (): BindingInvocationArgs =>
      this.withFetch({
        source: {
          bindingSpec: source.bindingSpec,
          location: source.location,
          // content: null is a PRESENT member — see prepareOperation.
          ...(source.content !== undefined ? { content: source.content } : {}),
        },
        selector: binding.selector ?? "",
        binding,
        inputSchema: op.input ?? undefined,
        interface: iface,
        context,
        signal: callerInv.signal,
        hooks,
        ...(site ? { site } : {}),
      });

    const mergeResolved = (resolved: Record<string, unknown>): boolean => {
      const next: Record<string, unknown> = { ...(context ?? {}), ...resolved };
      // The binding-invoker contract retries with the *augmented* context, not
      // a replaced one. Top-level credential fields are leaf values, so an
      // overwrite is correct — but `configuration` is a map keyed by
      // configuration point, and a resolved config.value (R1a) names one point;
      // overwriting the whole map would clobber sibling points the caller
      // already supplied. Merge it point-wise so a resolved `server` value does
      // not drop an existing `decode` override.
      const ec = (context ?? {})["configuration"];
      const rc = resolved["configuration"];
      const plain = (v: unknown): v is Record<string, unknown> =>
        typeof v === "object" && v !== null && !Array.isArray(v);
      if (plain(ec) && plain(rc)) {
        const configuration: Record<string, unknown> = { ...ec };
        for (const [point, value] of Object.entries(rc)) {
          configuration[point] = plain(configuration[point]) && plain(value)
            ? { ...configuration[point], ...value }
            : value;
        }
        next["configuration"] = configuration;
      }
      for (const field of ["credentials", "apiKeys"] as const) {
        const existing = (context ?? {})[field];
        const incoming = resolved[field];
        if (plain(existing) && plain(incoming)) next[field] = { ...existing, ...incoming };
      }
      const changed = !contextValuesEqual(context ?? {}, next);
      context = next;
      return changed;
    };

    // Preflight (binding-invoker interface `prepareBinding`): collapse
    // knowable-upfront context challenges into the clean
    // no-input-consumed case before anything is forwarded.
    try {
      const details = await (compiledBinding ?? this.invoker).prepareBinding(bindingArgs());
      if (details) {
        if (!isContextRequiredDetails(details)) {
          callerInv.fireError(new InvocationError(ERR_RUNTIME));
          return;
        }
        const resolvedCtx = this.contextResolver ? await this.contextResolver(details) : null;
        if (!resolvedCtx) {
          callerInv.fireError(
            contextRequiredError(details),
          );
          return;
        }
        if (!mergeResolved(resolvedCtx)) {
          callerInv.fireError(contextRequiredError(details));
          return;
        }
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
    let inputSurface: InvocationError | undefined;

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
            inputSurface ??= new InvocationError(ERR_TOO_MANY_INPUTS);
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
            } catch {
              await inner.cancel();
              callerInv.fireError(
                new InvocationError(ERR_TRANSFORM_ERROR),
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
              // The caller-side value was already accepted before the inner
              // binding's early close reached this pump. Surface the excess
              // instead of completing successfully after silently dropping it.
              inputSurface ??= new InvocationError(ERR_TOO_MANY_INPUTS);
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

    let rounds = 0;
    for (;;) {
      let inner: Invocation<unknown, unknown>;
      try {
        const args = bindingArgs();
        inner = compiledBinding?.invokeBindingAfterPreflight
          ? compiledBinding.invokeBindingAfterPreflight(args)
          : (compiledBinding ?? this.invoker).invokeBinding(args);
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
            } catch {
              await inner.cancel();
              surface = new InvocationError(ERR_TRANSFORM_ERROR);
              break;
            }
          }
          // OBI-T-16: an invalid output is not emitted; the invocation
          // terminates. Per-item for streaming bindings.
          if (outputValidator) {
            const r = safeValidate(outputValidator, data);
            if (!r.valid) {
              await inner.cancel();
              diagnostics?.recordValidation(
                "output",
                binding.operation,
                bindingKey,
                r.failures,
              );
              surface = new InvocationError(ERR_OPERATION_VALIDATION_FAILED);
              break;
            }
          }
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
          try {
            const resolvedCtx = await this.contextResolver(invErr.data);
            if (resolvedCtx && mergeResolved(resolvedCtx)) retry = true;
            else surface = invErr;
          } catch {
            surface = new InvocationError(ERR_RUNTIME);
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

      if (!retry && !surface && inputSurface) surface = inputSurface;

      if (retry) {
        rounds++;
        continue;
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
   * Returns a copy of args with the invoker-level runtime policy filled in
   * where the args don't already carry it: `fetch`, and the delivery-unit
   * bound (`maxDeliveryUnitBytes`) stamped the same way. Never mutates the
   * caller's args.
   */
  private withFetch(args: BindingInvocationArgs): BindingInvocationArgs {
    const needFetch = !args.fetch && this.fetch !== undefined;
    const needLimit =
      args.maxDeliveryUnitBytes === undefined && this.maxDeliveryUnitBytes !== undefined;
    if (!needFetch && !needLimit) return args;
    const filled = { ...args };
    if (needFetch) filled.fetch = this.fetch;
    if (needLimit) filled.maxDeliveryUnitBytes = this.maxDeliveryUnitBytes;
    return filled;
  }
}

/**
 * Builds the write-validation hook for an operation, compiling lazily on
 * first write. Validation carries the core's claim semantics (OBI-T-16):
 * the complete statically reachable schema graph, `format` as annotation,
 * applied per value — a mismatch is ERR_OPERATION_VALIDATION_FAILED; a graph that
 * cannot be established is ERR_SCHEMA_UNRESOLVED, never partial validation.
 */
function makeInputValidator(
  op: Operation,
  iface: OBInterface,
  operationName: string,
  bindingKey: string,
  diagnostics?: DiagnosticCollector,
): ((input: unknown) => InvocationError | null) | undefined {
  if (op.input == null) return undefined;
  let validator: CompiledSchema | undefined;
  let compileError: InvocationError | undefined;
  let compiled = false;
  return (input: unknown): InvocationError | null => {
    if (!compiled) {
      compiled = true;
      try {
        validator = compileOperationSchema(iface, operationName, "input");
      } catch {
        compileError = new InvocationError(ERR_SCHEMA_UNRESOLVED);
      }
    }
    if (compileError) return compileError;
    const r = safeValidate(validator!, input);
    if (!r.valid) {
      diagnostics?.recordValidation("input", operationName, bindingKey, r.failures);
      return new InvocationError(ERR_OPERATION_VALIDATION_FAILED);
    }
    return null;
  };
}

function validatorHook(
  validator: CompiledSchema | undefined,
  operationName: string,
  bindingKey: string,
  diagnostics?: DiagnosticCollector,
): ((input: unknown) => InvocationError | null) | undefined {
  if (!validator) return undefined;
  return (input: unknown): InvocationError | null => {
    const result = safeValidate(validator, input);
    if (!result.valid) {
      diagnostics?.recordValidation("input", operationName, bindingKey, result.failures);
    }
    return result.valid
      ? null
      : new InvocationError(ERR_OPERATION_VALIDATION_FAILED);
  };
}

function immutableValueSnapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

const immutableInterfaceSnapshots = new WeakSet<object>();

/** Creates a deep, immutable OBI snapshot without mutating the caller's value. */
export function snapshotInterface(iface: OBInterface): OBInterface {
  if (!iface) throw new MissingInterfaceError();
  if (immutableInterfaceSnapshots.has(iface)) return iface;
  const snapshot = immutableValueSnapshot(iface);
  immutableInterfaceSnapshots.add(snapshot);
  return snapshot;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function asInvocationError(err: unknown): InvocationError {
  if (err instanceof InvocationError) return err;
  return new InvocationError(ERR_RUNTIME);
}

/** JSON-domain structural comparison used only to suppress identical context retries. */
function contextValuesEqual(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown, seen: Set<object>): unknown => {
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) throw new TypeError("cyclic context");
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((entry) => canonical(entry, seen));
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, canonical(entry, seen)]),
      );
    } finally {
      seen.delete(value);
    }
  };
  try {
    return JSON.stringify(canonical(left, new Set())) === JSON.stringify(canonical(right, new Set()));
  } catch {
    return Object.is(left, right);
  }
}

/** Converts wiring errors (no invoker for format) raised mid-run into terminal invocation errors. */
function wireError(err: unknown): InvocationError {
  if (err instanceof InvocationError) return err;
  if (err instanceof Error && err.name === "NoInvokerError") {
    return new InvocationError(ERR_BINDING_NOT_FOUND);
  }
  return asInvocationError(err);
}

/**
 * Resolves the operation-invoker contract's context.configuration.selection
 * override: the first listed binding key that is invocable — defined on the
 * interface, targeting the resolved operation, and (when availableSpecs is
 * provided) governed by a specification the invoker can act on — wins.
 * Returns null when no listed key is invocable, in which case the
 * policy-neutral sole-candidate or ambiguity rule applies.
 */
function selectionOverride(
  iface: OBInterface,
  opKey: string,
  keys: string[],
  availableSpecs?: Set<string>,
): { key: string; binding: BindingEntry } | null {
  for (const k of keys) {
    const b = iface.bindings?.[k];
    if (!b || b.operation !== opKey) continue;
    if (availableSpecs) {
      const source = iface.sources?.[b.source];
      if (source && !availableSpecs.has(source.bindingSpec)) continue;
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
  return raw;
}

/**
 * Resolves the only invocable binding for an operation. It does not invent a
 * choice from preference, deprecation, key order, source order, or iteration
 * order. When availableSpecs is provided, bindings whose governing binding
 * specification is not in the set are skipped. Several remaining candidates
 * raise BindingSelectionRequiredError.
 */
export function defaultBindingSelector(
  iface: OBInterface,
  opKey: string,
  availableSpecs?: Set<string>,
): { key: string; binding: BindingEntry } {
  if (!iface.bindings || Object.keys(iface.bindings).length === 0) {
    throw new BindingNotFoundError(opKey);
  }

  let candidateKey: string | undefined;
  let candidate: BindingEntry | undefined;
  let candidateCount = 0;
  // Bindings that matched the operation but were skipped because no registered
  // invoker handles their governing binding specification. The distinction is
  // load-bearing for the error: "the document has no binding" sends the reader
  // to audit the OBI; "the binding needs a spec you didn't register" sends
  // them to their own OperationInvoker construction.
  const specSkipped = new Map<string, string>(); // binding key -> required binding spec

  for (const [k, b] of Object.entries(iface.bindings)) {
    if (b.operation !== opKey) continue;

    const source = iface.sources?.[b.source];

    // Skip bindings whose governing binding specification the invoker can't handle.
    if (availableSpecs && source && !availableSpecs.has(source.bindingSpec)) {
      specSkipped.set(k, source.bindingSpec);
      continue;
    }

    candidateCount += 1;
    if (!candidate) {
      candidateKey = k;
      candidate = b;
    }
  }

  if (!candidate || !candidateKey) {
    if (specSkipped.size > 0) {
      const needs = [...specSkipped.keys()]
        .sort()
        .map((k) => `"${k}" requires binding spec ${specSkipped.get(k)}`)
        .join(", ");
      const registered = availableSpecs ? [...availableSpecs].sort().join(", ") : "";
      throw new BindingNotFoundError(
        opKey,
        `binding ${needs}; registered binding specs: [${registered}] (did you register the spec's invoker in the OperationInvoker constructor?)`,
      );
    }
    throw new BindingNotFoundError(opKey);
  }
  if (candidateCount > 1) {
    throw new BindingSelectionRequiredError(opKey, candidateCount);
  }
  return { key: candidateKey, binding: candidate };
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
    throw new Error("openbindings: invalid transform: neither selector nor inline");
  }
  if (expr === "") throw new EmptyTransformExpressionError();
  return evaluator.evaluate(expr, data);
}

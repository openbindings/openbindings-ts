import type {
  OBInterface,
  BindingEntry,
  BindingSpecInfo,
  BindingSpecVerdict,
} from "@openbindings/core";
import type { BindingInvocationArgs } from "./invoker-types.js";
import type { BindingHandle, ContextRequiredDetails, Invocation } from "./invocation.js";

/**
 * Invokes bindings whose sources are governed by specific binding
 * specifications (e.g., openbindings.openapi-3.1@1, openbindings.mcp@1).
 *
 * `invokeBinding` returns the {@link Invocation} handle synchronously and
 * creation is inert: no I/O happens during construction. The binding's work
 * is scheduled asynchronously and MUST raise `CONTEXT_REQUIRED` (and any
 * other pre-dispatch failure) before any observable side effect.
 */
export interface BindingInvoker {
  /** Authoritatively checks support for exact, opaque identifiers. */
  checkBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[];
  /** Advisory discoverability metadata; absence is not evidence of non-support. */
  bindingSpecs(): BindingSpecInfo[];
  invokeBinding<I = unknown, O = unknown>(
    args: BindingInvocationArgs,
  ): Invocation<I, O>;
  /**
   * Optional side-effect-free preflight: reports the context the binding
   * would require for this invocation (the `prepareBinding` operation of
   * the openbindings.binding-invoker interface), or null when the binding can
   * proceed. Lets the operation layer resolve context BEFORE the caller
   * streams input, collapsing knowable-upfront challenges into the clean
   * no-input-consumed case.
   */
  prepareBinding?(
    args: BindingInvocationArgs,
  ): Promise<ContextRequiredDetails | null>;
}

/**
 * One statically selected binding-runtime route. Its implementation may pin a
 * parsed protocol operation or an in-process handler; repeated invocation
 * performs no binding-spec registry lookup.
 */
export interface CompiledBindingInvoker {
  invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O>;
  prepareBinding(args: BindingInvocationArgs): Promise<ContextRequiredDetails | null>;
  /**
   * Optional two-handle execution entry after the operation layer has already
   * evaluated `prepareBinding` for this invocation. It prevents a compiled
   * adapter from redundantly evaluating the same prerequisite callback.
   */
  invokeBindingAfterPreflight?<I = unknown, O = unknown>(
    args: BindingInvocationArgs,
  ): Invocation<I, O>;
  /**
   * Optional zero-bridge execution seam for an exact compiled binding.
   *
   * The operation layer supplies its own binding-facing handle after applying
   * the ordinary operation validation/transform boundary. Implementations
   * MUST NOT repeat `prepareBinding`: the operation layer evaluates it once
   * before entering this method. This capability is only used when reactive
   * context retry is not installed; other compiled bindings retain the
   * cardinality-neutral two-handle adapter.
   */
  invokeBindingHandle?<I = unknown, O = unknown>(
    handle: BindingHandle<I, O>,
    args: BindingInvocationArgs,
  ): Promise<void>;
}

/** Optional deterministic-closure capability of a binding invoker. */
export interface BindingCompiler {
  compileBinding(args: BindingInvocationArgs): CompiledBindingInvoker;
}

export function isBindingCompiler(value: BindingInvoker): value is BindingInvoker & BindingCompiler {
  return "compileBinding" in value &&
    typeof (value as unknown as Record<string, unknown>)["compileBinding"] === "function";
}

/** Evaluates a transform expression (e.g., JSONata) against input data. */
export interface TransformEvaluator {
  evaluate(expression: string, data: unknown): Promise<unknown>;
}

/**
 * Extends TransformEvaluator with support for additional named bindings
 * (e.g., $input in operation graph transforms). Invokers that need extra
 * context check for this interface via runtime duck-typing.
 */
export interface TransformEvaluatorWithBindings extends TransformEvaluator {
  evaluateWithBindings(
    expression: string,
    data: unknown,
    bindings: Record<string, unknown>,
  ): Promise<unknown>;
}

/** Runtime check for whether a TransformEvaluator supports bindings. */
export function isTransformEvaluatorWithBindings(
  e: TransformEvaluator,
): e is TransformEvaluatorWithBindings {
  return (
    "evaluateWithBindings" in e &&
    typeof (e as Record<string, unknown>)["evaluateWithBindings"] === "function"
  );
}

/** Selects which binding to use for a given operation. */
export type BindingSelector = (
  iface: OBInterface,
  opKey: string,
) => { key: string; binding: BindingEntry };

/**
 * Resolves a `CONTEXT_REQUIRED` challenge into context data, or null to
 * decline. Composition-time wiring on the operation invoker: whether it
 * consults a context store, reads an env var, prompts a keychain, or
 * returns a hardcoded value is the resolver's business — invisible to the
 * invoker and to bindings.
 *
 * A CONTEXT_REQUIRED challenge is a scope, not a hint. A resolver MUST return
 * only the context that satisfies the selected alternative and never
 * unrelated stored values. Headers, cookies, environment values, metadata,
 * and configuration can all be sensitive; {@link scopeContext} therefore
 * admits only fields named by the selected requirements.
 */
export type ContextResolver = (
  details: ContextRequiredDetails,
) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;

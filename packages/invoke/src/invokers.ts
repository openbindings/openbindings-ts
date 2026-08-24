import type { OBInterface, BindingEntry, BindingSpecInfo, BindingSpecVerdict } from "@openbindings/core";
import type { BindingInvocationArgs } from "./invoker-types.js";
import type { ContextRequiredDetails, Invocation } from "./invocation.js";

/**
 * Invokes bindings whose sources are governed by specific binding
 * specifications (e.g., openbindings.openapi@1, openbindings.mcp@1).
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
  invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O>;
  /**
   * Optional side-effect-free preflight: reports the context the binding
   * would require for this invocation (the `prepareBinding` operation of
   * the openbindings.binding-invoker interface), or null when the binding can
   * proceed. Lets the operation layer resolve context BEFORE the caller
   * streams input, collapsing knowable-upfront challenges into the clean
   * no-input-consumed case.
   */
  prepareBinding?(args: BindingInvocationArgs): Promise<ContextRequiredDetails | null>;
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
  evaluateWithBindings(expression: string, data: unknown, bindings: Record<string, unknown>): Promise<unknown>;
}

/** Runtime check for whether a TransformEvaluator supports bindings. */
export function isTransformEvaluatorWithBindings(
  e: TransformEvaluator,
): e is TransformEvaluatorWithBindings {
  return "evaluateWithBindings" in e
    && typeof (e as Record<string, unknown>)["evaluateWithBindings"] === "function";
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

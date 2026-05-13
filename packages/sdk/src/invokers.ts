import type { OBInterface, BindingEntry, Source } from "./types.js";
import type {
  BindingInvocationInput,
  CreateInput,
  InvocationOutput,
  FormatInfo,
  SourceInspection,
} from "./invoker-types.js";

/**
 * Invokes bindings against format-specific sources.
 * Implementations handle a specific binding format (e.g., OpenAPI, gRPC, MCP).
 * Callers must consume the returned async iterable to avoid resource leaks.
 */
export interface BindingInvoker {
  formats(): FormatInfo[];
  invokeBinding(
    input: BindingInvocationInput,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<InvocationOutput>;
}

/**
 * Creates OpenBindings interfaces from format-specific sources.
 * Independent of {@link BindingInvoker} -- an implementation may provide one, the other, or both.
 */
export interface InterfaceCreator {
  formats(): FormatInfo[];
  createInterface(
    input: CreateInput,
    options?: { signal?: AbortSignal },
  ): Promise<OBInterface>;
}

/**
 * Inspects binding source artifacts and returns bindable targets that tooling
 * can frame as OpenBindings operations.
 */
export interface SourceInspector {
  formats(): FormatInfo[];
  inspectSource(
    source: Source,
    options?: { signal?: AbortSignal },
  ): Promise<SourceInspection>;
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

/** Type guard that checks whether a {@link BindingInvoker} also implements {@link InterfaceCreator}. */
export function isInterfaceCreator(
  p: BindingInvoker,
): p is BindingInvoker & InterfaceCreator {
  return "createInterface" in p
    && typeof (p as unknown as Record<string, unknown>)["createInterface"] === "function";
}

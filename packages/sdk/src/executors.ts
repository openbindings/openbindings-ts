import type { OBInterface, BindingEntry, Source } from "./types.js";
import type {
  BindingExecutionInput,
  CreateInput,
  StreamEvent,
  FormatInfo,
  ListRefsResult,
} from "./executor-types.js";

/**
 * Executes bindings against format-specific sources.
 * Implementations handle a specific binding format (e.g., OpenAPI, gRPC, MCP).
 * Callers must consume the returned async iterable to avoid resource leaks.
 */
export interface BindingExecutor {
  formats(): FormatInfo[];
  executeBinding(
    input: BindingExecutionInput,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<StreamEvent>;
}

/**
 * Creates OpenBindings interfaces from format-specific sources.
 * Independent of {@link BindingExecutor} -- an implementation may provide one, the other, or both.
 */
export interface InterfaceCreator {
  formats(): FormatInfo[];
  createInterface(
    input: CreateInput,
    options?: { signal?: AbortSignal },
  ): Promise<OBInterface>;
  /**
   * List the bindable refs available in a source. Optional -- when not
   * implemented, tooling should fall back to manual ref entry.
   * Accepts the document-level Source (format + location + content).
   */
  listBindableRefs?(
    source: Source,
    options?: { signal?: AbortSignal },
  ): Promise<ListRefsResult>;
}

/** Evaluates a transform expression (e.g., JSONata) against input data. */
export interface TransformEvaluator {
  evaluate(expression: string, data: unknown): Promise<unknown>;
}

/**
 * Extends TransformEvaluator with support for additional named bindings
 * (e.g., $input in operation graph transforms). Executors that need extra
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

/** Type guard that checks whether a {@link BindingExecutor} also implements {@link InterfaceCreator}. */
export function isInterfaceCreator(
  p: BindingExecutor,
): p is BindingExecutor & InterfaceCreator {
  return "createInterface" in p
    && typeof (p as unknown as Record<string, unknown>)["createInterface"] === "function";
}

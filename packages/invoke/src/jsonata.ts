import { parse, stringify } from "@openbindings/json";
import type { TransformEvaluationOptions, TransformEvaluatorWithBindings } from "./invokers.js";

/** A JSON-text executor supplied by the selected runtime. This is an adapter
 * seam, not a new expression format or a Core precision requirement. Resource
 * policy, worker lifetime and numerical guarantees remain with the executor. */
export interface JSONataTextExecutor {
  evaluate(expression: string, inputJSON: string, options?: {
    bindingsJSON?: string;
    signal?: AbortSignal;
  }): Promise<string>;
}

/** Connect a selected JSONata executor to the ordinary invocation interface.
 * The official runtime supplies exact carriage and its documented arithmetic;
 * this adapter does not attribute those guarantees to an arbitrary executor.
 * No evaluator is imported, initialized or selected by the generic SDK. */
export function createJSONataEvaluator(executor: JSONataTextExecutor): TransformEvaluatorWithBindings {
  const evaluate = async (expression: string, data: unknown, bindings: Record<string, unknown> | undefined, options?: TransformEvaluationOptions): Promise<unknown> => {
    options?.signal?.throwIfAborted();
    const inputJSON = stringify(data as never);
    const bindingsJSON = bindings === undefined ? undefined : stringify(bindings as never);
    options?.signal?.throwIfAborted();
    const output = await executor.evaluate(expression, inputJSON, {bindingsJSON, signal: options?.signal});
    options?.signal?.throwIfAborted();
    return parse(output);
  };
  return Object.freeze({
    evaluate: (expression: string, data: unknown, options?: TransformEvaluationOptions) => evaluate(expression,data,undefined,options),
    evaluateWithBindings: (expression: string, data: unknown, bindings: Record<string, unknown>, options?: TransformEvaluationOptions) => evaluate(expression,data,bindings,options),
  });
}

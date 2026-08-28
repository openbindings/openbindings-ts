import { InvocationError, type BindingInvocationArgs, type InvocationImpl } from "@openbindings/invoke";
import {
  Swagger20ExecutionError,
  prepareSwagger20,
  type Swagger20Source,
} from "@openbindings/openapi-client/engine";

/**
 * Edition-specific adapter dispatch. This file owns only SDK vocabulary;
 * artifact loading, reference resolution, and selector meaning stay in the
 * standalone client's native Swagger 2.0 lane.
 */
export async function runSwagger20Adapter<I, O>(
  args: BindingInvocationArgs,
  invocation: InvocationImpl<I, O>,
): Promise<void> {
  const source: Swagger20Source = {
    ...(args.source.location !== undefined ? { location: args.source.location } : {}),
    ...(args.source.content !== undefined ? { content: args.source.content } : {}),
  };
  let prepared;
  try {
    prepared = await prepareSwagger20({
      source,
      ref: args.selector,
      context: args.context,
      signal: args.signal,
      fetch: args.fetch,
    });
  } catch (error: unknown) {
    throw bridgeSwagger20Error(error);
  }

  const iterator = invocation.inputs()[Symbol.asyncIterator]();
  const first = await iterator.next();
  const second = first.done ? first : await iterator.next();
  if (!second.done) throw new InvocationError("ERR_REFUSED");
  await invocation.closeInput();
  try {
    const result = await prepared.execute(first.done ? undefined : first.value);
    if (result.outputPresent) await invocation.emitOutput(result.output as O);
    invocation.closeOutput();
  } catch (error: unknown) {
    throw bridgeSwagger20Error(error);
  }
}

export function bridgeSwagger20Error(error: unknown): InvocationError {
  if (error instanceof InvocationError) return new InvocationError(error.code, error.data);
  if (!(error instanceof Swagger20ExecutionError)) return new InvocationError("ERR_RUNTIME");
  const code = error.code === "SOURCE_LOAD_FAILED" ? "ERR_SOURCE_LOAD_FAILED"
    : error.code === "INVALID_OPERATION_REF" ? "ERR_INVALID_SELECTOR"
    : error.code === "OPERATION_NOT_FOUND" ? "ERR_SELECTOR_NOT_FOUND"
    : error.code;
  return error.details === undefined ? new InvocationError(code) : new InvocationError(code, error.details);
}

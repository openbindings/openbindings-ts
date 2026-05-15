import type { OBInterface } from "./types.js";
import type { InvocationOutput } from "./invoker-types.js";
import type { ContextStore, PlatformCallbacks } from "./context.js";
import type { OperationInvoker } from "./operation-invoker.js";

export type OperationEntry = { input?: unknown; output?: unknown };

export interface InterfaceClientOptions {
  contextStore?: ContextStore;
  platformCallbacks?: PlatformCallbacks;
  defaultContext?: Record<string, unknown>;
}

/**
 * Dispatches operations against an OBI through an invoker.
 *
 * Construction is synchronous and side-effect free. The caller is
 * responsible for acquiring the OBI (e.g., via `fetchInterface(url)`,
 * loading from disk, or constructing in memory) and validating it
 * against any required contract (e.g., via `checkInterfaceCompatibility`)
 * before passing it here.
 */
export class InterfaceClient<T = Record<string, OperationEntry>> {
  readonly interface: OBInterface;
  private readonly invoker: OperationInvoker;
  private readonly defaultContext?: Record<string, unknown>;

  constructor(
    iface: OBInterface,
    invoker: OperationInvoker,
    opts?: InterfaceClientOptions,
  ) {
    this.interface = iface;
    this.invoker = (opts?.contextStore || opts?.platformCallbacks)
      ? invoker.withRuntime(opts.contextStore, opts.platformCallbacks)
      : invoker;
    this.defaultContext = opts?.defaultContext;
  }

  /**
   * Invokes an operation, yielding a stream of events. Unary operations
   * produce exactly one event.
   */
  async *invoke<K extends string & keyof T>(
    operation: K,
    input?: K extends keyof T ? (T[K] extends { input: infer I } ? I : undefined) : unknown,
    context?: Record<string, unknown>,
  ): AsyncGenerator<InvocationOutput> {
    const merged = mergeContext(this.defaultContext, context);
    yield* this.invoker.invoke({
      interface: this.interface,
      operation,
      input,
      context: merged,
    });
  }

  interfaceJSON(): string {
    return JSON.stringify(this.interface, null, 2);
  }
}

function mergeContext(
  defaults?: Record<string, unknown>,
  perCall?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!defaults) return perCall;
  if (!perCall) return defaults;
  return { ...defaults, ...perCall };
}

import type { OBInterface } from "./types.js";
import type { InvocationOutput } from "./invoker-types.js";
import type { InvocationOptions, ContextStore, PlatformCallbacks } from "./context.js";
import type { OperationInvoker } from "./operation-invoker.js";

export type OperationEntry = { input?: unknown; output?: unknown };

export interface InterfaceClientOptions {
  contextStore?: ContextStore;
  platformCallbacks?: PlatformCallbacks;
  defaultOptions?: InvocationOptions;
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
  private readonly defaultOptions?: InvocationOptions;

  constructor(
    iface: OBInterface,
    invoker: OperationInvoker,
    opts?: InterfaceClientOptions,
  ) {
    this.interface = iface;
    this.invoker = (opts?.contextStore || opts?.platformCallbacks)
      ? invoker.withRuntime(opts.contextStore, opts.platformCallbacks)
      : invoker;
    this.defaultOptions = opts?.defaultOptions;
  }

  /**
   * Invokes an operation, yielding a stream of events. Unary operations
   * produce exactly one event.
   */
  async *invoke<K extends string & keyof T>(
    operation: K,
    input?: K extends keyof T ? (T[K] extends { input: infer I } ? I : undefined) : unknown,
    options?: InvocationOptions,
  ): AsyncGenerator<InvocationOutput> {
    const merged = mergeInvocationOptions(this.defaultOptions, options);
    yield* this.invoker.invoke({
      interface: this.interface,
      operation,
      input,
      options: merged,
    });
  }

  interfaceJSON(): string {
    return JSON.stringify(this.interface, null, 2);
  }
}

function mergeInvocationOptions(
  defaults?: InvocationOptions,
  perCall?: InvocationOptions,
): InvocationOptions | undefined {
  if (!defaults) return perCall;
  if (!perCall) return defaults;
  return {
    headers: mergeMaps(defaults.headers, perCall.headers),
    cookies: mergeMaps(defaults.cookies, perCall.cookies),
    environment: mergeMaps(defaults.environment, perCall.environment),
    metadata: mergeMaps(defaults.metadata, perCall.metadata),
  };
}

function mergeMaps<V>(
  base?: Record<string, V>,
  overlay?: Record<string, V>,
): Record<string, V> | undefined {
  if (!overlay || Object.keys(overlay).length === 0) return base;
  if (!base || Object.keys(base).length === 0) return overlay;
  return { ...base, ...overlay };
}

import type { OBInterface } from "./types.js";
import type { StreamEvent } from "./executor-types.js";
import type { InterfaceCreator } from "./executors.js";
import type { ExecutionOptions, ContextStore, PlatformCallbacks } from "./context.js";
import type { OperationExecutor } from "./executor.js";
import { isHttpUrl } from "./helpers.js";
import { combineCreators } from "./combiners.js";
import {
  checkInterfaceCompatibility,
  isOBInterface,
  type CompatibilityIssue,
  type CheckCompatibilityOptions,
} from "./compatibility.js";

const WELL_KNOWN_PATH = "/.well-known/openbindings";

export type OperationEntry = { input?: unknown; output?: unknown };

export type InterfaceClientState =
  | { kind: "idle" }
  | { kind: "resolving"; target: string }
  | { kind: "bound"; target: string; iface: OBInterface; synthesized: boolean }
  | { kind: "incompatible"; target: string; iface: OBInterface; issues: CompatibilityIssue[] }
  | { kind: "error"; target: string; message: string };

export interface InterfaceClientOptions {
  /** Role key identifying this client's required interface (e.g., "openbindings.workspace-manager").
   *  Enables `satisfies`-based capability matching during resolution. */
  interfaceId?: string;
  contextStore?: ContextStore;
  platformCallbacks?: PlatformCallbacks;
  defaultOptions?: ExecutionOptions;
  fetch?: typeof globalThis.fetch;
  onStateChange?: () => void;
}

interface ResolveResult {
  iface: OBInterface;
  native: boolean;
}

/**
 * A stateful object that resolves an OBI from a service and optionally
 * validates it against a required interface. Once resolved, operations can
 * be executed through it.
 *
 * **Demand mode** — pass a required `OBInterface` to enforce compatibility:
 * "I need these capabilities — find me something compatible and let me use it."
 *
 * **Discovery mode** — pass `null` to accept any service unconditionally:
 * "Connect to this service and show me what it offers." Use `conforms()`
 * after resolution to check capabilities ad-hoc.
 */
export class InterfaceClient<T = Record<string, OperationEntry>> {
  readonly interface: OBInterface | null;

  private executor: OperationExecutor;
  private readonly defaultOptions?: ExecutionOptions;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly onStateChange?: () => void;
  private readonly interfaceId?: string;
  private abortController?: AbortController;
  private resolvedInterface?: OBInterface;
  private synthesizer: InterfaceCreator | null = null;
  private _state: InterfaceClientState = { kind: "idle" };
  private lastTarget?: string;

  constructor(
    iface: OBInterface | null,
    executor: OperationExecutor,
    opts?: InterfaceClientOptions,
  ) {
    this.interface = iface;
    this.executor = executor;
    this.interfaceId = opts?.interfaceId;
    this.defaultOptions = opts?.defaultOptions;
    if (opts?.fetch) {
      this.fetchFn = opts.fetch;
    } else if (typeof globalThis.fetch === "function") {
      this.fetchFn = globalThis.fetch.bind(globalThis);
    } else {
      this.fetchFn = (() => Promise.reject(new Error(
        "openbindings: fetch is not available — provide a fetch implementation via InterfaceClientOptions",
      ))) as typeof globalThis.fetch;
    }
    this.onStateChange = opts?.onStateChange;

    if (opts?.contextStore || opts?.platformCallbacks || opts?.fetch) {
      this.executor = this.executor.withRuntime(
        opts.contextStore,
        opts.platformCallbacks,
        opts.fetch,
      );
    }
  }

  get state(): InterfaceClientState {
    return this._state;
  }

  get resolved(): OBInterface | undefined {
    return this.resolvedInterface;
  }

  get issues(): CompatibilityIssue[] {
    return this._state.kind === "incompatible" ? this._state.issues : [];
  }

  get synthesized(): boolean {
    return this._state.kind === "bound" && this._state.synthesized;
  }

  /**
   * Checks whether the resolved service structurally conforms to the given
   * required interface. Returns an empty array when fully compatible.
   *
   * This is useful in discovery mode (`new InterfaceClient(null, ...)`) where
   * no upfront requirements are enforced — resolve first, then probe for
   * specific capabilities ad-hoc:
   *
   * ```ts
   * const client = new InterfaceClient(null, executor);
   * await client.resolve("http://localhost:20290");
   * const issues = client.conforms(workspaceManagerIface, "openbindings.workspace-manager");
   * ```
   *
   * @throws {Error} If called before the client has resolved a service.
   */
  async conforms(required: OBInterface, interfaceId?: string): Promise<CompatibilityIssue[]> {
    if (!this.resolvedInterface) {
      throw new Error("Cannot check conformance before resolution");
    }
    return checkInterfaceCompatibility(
      required,
      this.resolvedInterface,
      interfaceId ? { requiredInterfaceId: interfaceId } : undefined,
    );
  }

  abort(): void {
    this.abortController?.abort();
  }

  /**
   * Cancels any in-flight resolution, resets state to idle, and clears
   * the resolved interface. Idempotent.
   */
  close(): void {
    this.abortController?.abort();
    this.abortController = undefined;
    this.resolvedInterface = undefined;
    this.lastTarget = undefined;
    this.setState({ kind: "idle" });
  }

  async resolve(
    target: string | OBInterface,
    opts?: { signal?: AbortSignal; creators?: InterfaceCreator[] },
  ): Promise<void> {
    this.synthesizer = opts?.creators?.length
      ? combineCreators(...opts.creators)
      : null;

    this.abortController?.abort();
    this.abortController = new AbortController();

    const internal = this.abortController.signal;
    const signal = opts?.signal
      ? AbortSignal.any([opts.signal, internal])
      : internal;

    if (typeof target !== "string") {
      this.lastTarget = undefined;
      await this.applyResolved(target, "", false);
      return;
    }

    const url = target.trim();
    if (!url) {
      this.lastTarget = undefined;
      this.setState({ kind: "idle" });
      return;
    }

    this.lastTarget = url;
    this.setState({ kind: "resolving", target: url });

    // Fast path: if the URL is non-HTTP (e.g. `workers-rpc://service-name`,
    // `exec:my-cli`, or any other transport scheme that the SDK can't
    // GET) AND the constructor was given an embedded interface, use the
    // embedded one without attempting to fetch or synthesize. This is
    // the codegen-client flow for non-HTTP transports where the URL
    // is symbolic (a binding name, a process target, etc.) and the
    // OBI is fully known at codegen time.
    //
    // Without this fallback, codegenned clients for non-HTTP transports
    // can't `connect()` at all — they fail with "No creator could
    // synthesize an interface from <url>" because the SDK has no way to
    // fetch the URL and no creator that can derive an OBI from a
    // symbolic identifier. The embedded OBI is the source of truth in
    // this case; the URL is just a label.
    if (!isHttpUrl(url) && this.interface && !this.synthesizer) {
      await this.applyResolved(this.interface, url, false);
      return;
    }

    let result: ResolveResult;

    try {
      result = await this.resolveFromUrl(url, signal);
    } catch (e: unknown) {
      if (signal.aborted) return;
      this.setState({
        kind: "error",
        target: url,
        message: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    if (signal.aborted) return;

    await this.applyResolved(result.iface, url, !result.native);
  }

  /**
   * Re-resolves against the same target, bypassing any caches.
   * For HTTP targets this re-fetches the content and passes it to executors
   * so cached parsed documents are replaced with fresh versions.
   */
  async refresh(opts?: { signal?: AbortSignal }): Promise<void> {
    if (!this.lastTarget) return;

    const target = this.lastTarget;
    if (!isHttpUrl(target)) {
      const resolveOpts: { signal?: AbortSignal; creators?: InterfaceCreator[] } = { ...opts };
      if (this.synthesizer) {
        resolveOpts.creators = [this.synthesizer];
      }
      await this.resolve(target, resolveOpts);
      return;
    }

    this.abortController?.abort();
    this.abortController = new AbortController();
    const internal = this.abortController.signal;
    const signal = opts?.signal
      ? AbortSignal.any([opts.signal, internal])
      : internal;

    this.setState({ kind: "resolving", target });

    try {
      // Try direct OBI fetch first
      const direct = await this.tryFetchOBI(target, signal);
      if (direct) { await this.applyResolved(direct, target, false); return; }

      // Try well-known discovery
      if (!shouldSkipWellKnownDiscovery(target)) {
        const wellKnown = await this.tryFetchOBI(
          target.replace(/\/+$/, "") + WELL_KNOWN_PATH,
          signal,
        );
        if (wellKnown) { await this.applyResolved(wellKnown, target, false); return; }
      }

      // Fetch fresh content for cache-busting synthesis
      const content = await this.fetchRawContent(target, signal);
      const iface = await this.synthesizeWithContent(target, content, signal);
      await this.applyResolved(iface, target, true);
    } catch (e: unknown) {
      if (signal.aborted) return;
      this.setState({
        kind: "error",
        target,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Executes an operation, returning a stream of events. Every operation is
   * a stream — unary calls produce exactly one event.
   */
  async *execute<K extends string & keyof T>(
    operation: K,
    input?: K extends keyof T ? (T[K] extends { input: infer I } ? I : undefined) : unknown,
    options?: ExecutionOptions,
  ): AsyncGenerator<StreamEvent> {
    if (this._state.kind !== "bound" || !this.resolvedInterface) {
      throw new Error(`openbindings: client is not bound to a service (state: ${this._state.kind})`);
    }

    const merged = mergeExecutionOptions(this.defaultOptions, options);

    yield* this.executor.executeOperation(
      { interface: this.resolvedInterface, operation, input, options: merged },
    );
  }

  interfaceJSON(): string {
    return this.interface ? JSON.stringify(this.interface, null, 2) : "null";
  }

  // -- Private --

  private async resolveFromUrl(
    url: string,
    signal: AbortSignal,
  ): Promise<ResolveResult> {
    if (isHttpUrl(url)) {
      const direct = await this.tryFetchOBI(url, signal);
      if (direct) return { iface: direct, native: true };

      if (!shouldSkipWellKnownDiscovery(url)) {
        const wellKnown = await this.tryFetchOBI(
          url.replace(/\/+$/, "") + WELL_KNOWN_PATH,
          signal,
        );
        if (wellKnown) return { iface: wellKnown, native: true };
      }
    }

    const iface = await this.synthesize(url, signal);
    return { iface, native: false };
  }

  private async tryFetchOBI(
    url: string,
    signal: AbortSignal,
  ): Promise<OBInterface | null> {
    try {
      const resp = await this.fetchFn(url, { signal });
      if (!resp.ok) return null;
      const body = await resp.json();
      if (isOBInterface(body)) return body;
    } catch {
      return null;
    }
    return null;
  }

  private async synthesize(
    location: string,
    signal: AbortSignal,
  ): Promise<OBInterface> {
    if (!this.synthesizer) {
      throw new Error(`No creator could synthesize an interface from ${location}`);
    }

    const formats = this.synthesizer.formats();
    let lastError: unknown;

    for (const info of formats) {
      try {
        return await this.synthesizer.createInterface(
          { sources: [{ format: info.token, location }] },
          { signal },
        );
      } catch (e: unknown) {
        lastError = e;
      }
    }

    throw lastError ?? new Error(`No creator could synthesize an interface from ${location}`);
  }

  /**
   * Synthesizes with pre-fetched content so creator caches are bypassed.
   */
  private async synthesizeWithContent(
    location: string,
    content: string,
    signal: AbortSignal,
  ): Promise<OBInterface> {
    if (!this.synthesizer) {
      throw new Error(`No creator could synthesize an interface from ${location}`);
    }

    const formats = this.synthesizer.formats();
    let lastError: unknown;

    for (const info of formats) {
      try {
        return await this.synthesizer.createInterface(
          { sources: [{ format: info.token, location, content }] },
          { signal },
        );
      } catch (e: unknown) {
        lastError = e;
      }
    }

    throw lastError ?? new Error(`No creator could synthesize an interface from ${location}`);
  }

  private async fetchRawContent(url: string, signal: AbortSignal): Promise<string> {
    const resp = await this.fetchFn(url, { signal });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} fetching ${url.split("?")[0]}`);
    }
    return resp.text();
  }

  private async applyResolved(
    iface: OBInterface,
    target: string,
    synthesized: boolean,
  ): Promise<void> {
    if (this.interface) {
      const compatOpts: CheckCompatibilityOptions | undefined = this.interfaceId
        ? { requiredInterfaceId: this.interfaceId }
        : undefined;
      const issues = await checkInterfaceCompatibility(this.interface, iface, compatOpts);
      if (issues.length > 0) {
        this.resolvedInterface = undefined;
        this.setState({ kind: "incompatible", target, iface, issues });
        return;
      }
    }
    this.resolvedInterface = iface;
    this.setState({ kind: "bound", target, iface, synthesized });
  }

  private setState(state: InterfaceClientState): void {
    this._state = state;
    this.onStateChange?.();
  }
}

function mergeExecutionOptions(
  defaults?: ExecutionOptions,
  perCall?: ExecutionOptions,
): ExecutionOptions | undefined {
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

function shouldSkipWellKnownDiscovery(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return (
      path.endsWith(".json") ||
      path.endsWith(".yaml") ||
      path.endsWith(".yml") ||
      path.includes("/openapi") ||
      path.includes("/swagger") ||
      path.includes("/asyncapi") ||
      path.endsWith(WELL_KNOWN_PATH)
    );
  } catch {
    return false;
  }
}

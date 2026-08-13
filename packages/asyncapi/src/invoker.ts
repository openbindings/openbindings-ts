import type {
  BindingInvoker,
  CoverageSynthesizer,
  InterfaceSynthesizer,
  SourceInspector,
  BindingInvocationArgs,
  ContextRequiredDetails,
  SynthesizeInput,
  Invocation,
  OBInterface,
  Source,
  BindingSpecInfo,
  SourceInspection,
  SynthesizeResult,
} from "@openbindings/sdk";
import {
  InvocationError,
  InvocationImpl,
  MultipleSourcesError,
  isContextRequiredDetails,
  finalizeSynthesis,
  finalizeSynthesisCoverage,
  synthesisSkeleton,
} from "@openbindings/sdk";
import {
  ASYNCAPI_PROFILE_FULL,
  ASYNCAPI_USE_DEFAULT,
  AsyncAPIEngine,
  AsyncAPIExecutionError,
  type AsyncAPIExecution,
  type AsyncAPIExecutionHooks,
  type AsyncAPIHookResult,
} from "@openbindings/asyncapi-client/engine";
import type { AsyncAPIDocument } from "./asyncapi-types.js";
import { BINDING_SPEC, DEFAULT_SOURCE_NAME } from "./constants.js";
import { bindableOperationEntries, convertToInterface } from "./synthesize.js";
import { synthesisCoverage } from "./coverage.js";
import { operationRef, parseAsyncAPIDocument, errorMessage, sanitizeKey, uniqueKey, validateDocumentAddress } from "./util.js";
import {
  normalizeAuthoringLocation,
  readAuthoringArtifact,
} from "./platform.js";

// ---------------------------------------------------------------------------
// Invoker
// ---------------------------------------------------------------------------

/** Invokes the unreleased AsyncAPI @1 candidate through the standalone runtime. */
export class AsyncAPIInvoker implements BindingInvoker {
  private readonly engine: AsyncAPIEngine;

  constructor(engine: AsyncAPIEngine = new AsyncAPIEngine()) {
    this.engine = engine;
  }

  /** Returns the binding specifications this invoker supports, by exact identifier. */
  bindingSpecs(): BindingSpecInfo[] {
    return [
      { bindingSpec: BINDING_SPEC, description: "AsyncAPI 2.0–2.6 and 3.0–3.1 event-driven APIs" },
    ];
  }

  /**
   * Shuts down all pooled WebSocket connections. After close returns, the
   * invoker should not be used for new invocations. Mirrors the Go SDK's
   * Close discipline on resource-holding invokers.
   */
  close(): void {
    this.engine.close();
  }

  /**
   * Invokes a single binding, returning the invocation handle synchronously.
   * Construction is inert; the binding's work is scheduled asynchronously
   * and all pre-dispatch failures (including CONTEXT_REQUIRED) are raised
   * before any observable side effect.
   */
  invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
    const inv = new InvocationImpl<I, O>({ signal: args.signal });
    queueMicrotask(() => {
      void this.runAdapter(args, inv).catch((error: unknown) => {
        inv.fireError(toSDKError(error));
      });
    });
    return inv;
  }

  /**
   * Side-effect-free preflight: reports the context this binding would
   * require, or null when the binding can proceed (or the answer is not
   * knowable without network I/O). Only inline source content and the warm
   * doc cache are consulted; nothing is fetched — including external $refs
   * inside inline content, which parse against a rejecting fetch and
   * collapse to "not knowable" (null).
   */
  async prepareBinding(args: BindingInvocationArgs): Promise<ContextRequiredDetails | null> {
    try {
      const prepared = await this.engine.prepareCached({
        source: { location: args.source.location, content: args.source.content },
        ref: args.ref,
        profile: profileForBindingSpec(args.source.bindingSpec),
        context: args.context,
        signal: args.signal,
        fetch: args.fetch,
        hooks: adaptHooks(args),
        maxDeliveryUnitBytes: args.maxDeliveryUnitBytes,
        acceptsInput: args.binding === undefined || args.inputSchema !== undefined,
      });
      return prepared?.prerequisites ?? null;
    } catch {
      return null;
    }
  }

  private async runAdapter<I, O>(
    args: BindingInvocationArgs,
    outer: InvocationImpl<I, O>,
  ): Promise<void> {
    const prepared = await this.engine.prepare({
      source: { location: args.source.location, content: args.source.content },
      ref: args.ref,
      profile: profileForBindingSpec(args.source.bindingSpec),
      context: args.context,
      signal: outer.signal,
      fetch: args.fetch,
      hooks: adaptHooks(args),
      maxDeliveryUnitBytes: args.maxDeliveryUnitBytes,
      acceptsInput: args.binding === undefined || args.inputSchema !== undefined,
    });
    await bridgeExecution(prepared.start<I, O>(), outer);
  }
}

function profileForBindingSpec(bindingSpec: string) {
  if (bindingSpec === BINDING_SPEC) return ASYNCAPI_PROFILE_FULL;
  throw new AsyncAPIExecutionError(
    "SOURCE_CONFIG_ERROR",
    `unsupported AsyncAPI binding specification ${JSON.stringify(bindingSpec)}`,
  );
}

async function bridgeExecution<I, O>(
  execution: AsyncAPIExecution<I, O>,
  outer: InvocationImpl<I, O>,
): Promise<void> {
  const mirrorInnerInputClose = execution.inputFinished.then(() => outer.closeInput());
  const input = (async () => {
    try {
      for await (const value of outer.inputs()) await execution.send(value);
      await execution.finishInput();
    } catch (error: unknown) {
      if (!outer.signal.aborted) throw error;
    }
  })();
  const output = (async () => {
    for await (const event of execution.events) await outer.emitOutput(event.value);
    await execution.completed;
    outer.closeOutput();
  })();
  try {
    await output;
  } catch (error: unknown) {
    outer.fireError(toSDKError(error));
  } finally {
    await execution.cancel();
    await Promise.allSettled([input, mirrorInnerInputClose]);
  }
}

function adaptHooks(args: BindingInvocationArgs): AsyncAPIExecutionHooks | undefined {
  const hooks = args.hooks;
  if (!hooks) return undefined;
  const site = (target: string) => ({
    ...(args.site ?? {
      operation: "",
      invokedAs: "",
      bindingKey: "",
      bindingSpec: args.source.bindingSpec,
      ref: args.ref,
      target: "",
    }),
    target,
  });
  const raw = (result: AsyncAPIHookResult) => ({
    status: result.status,
    body: result.body,
    meta: cloneMetadata(result.metadata),
  });
  return {
    decode: async (engineSite, result) => {
      const declined = Symbol("asyncapi-adapter: decode declined");
      try {
        const value = await hooks.decodeOutput(
          site(engineSite.target),
          raw(result),
          () => declined,
        );
        return value === declined ? ASYNCAPI_USE_DEFAULT : value;
      } catch (error: unknown) {
        throw toEngineError(error);
      }
    },
  };
}

function toSDKError(error: unknown): InvocationError {
  try {
    return mapSDKError(error);
  } catch {
    // Third-party drivers are an extension point. A malformed portability
    // marker must terminate safely instead of stranding the outer handle.
    return new InvocationError("ERR_RUNTIME");
  }
}

function mapSDKError(error: unknown): InvocationError {
  if (error instanceof InvocationError) return error;
  if (error instanceof AsyncAPIExecutionError) {
    const authored = sdkInvocationCause(error);
    if (authored) return new InvocationError(authored.code, authored.data);
    const code = error.code === "SOURCE_LOAD_FAILED" ? "ERR_SOURCE_LOAD_FAILED"
      : error.code === "INVALID_OPERATION_REF" ? "ERR_INVALID_REF"
      : error.code === "OPERATION_NOT_FOUND" ? "ERR_REF_NOT_FOUND"
      : error.code;
    if (code === "CONTEXT_REQUIRED" && isContextRequiredDetails(error.details)) {
      return new InvocationError(code, error.details);
    }
    const portable = portableAsyncAPIData(error);
    if (portable.present) return new InvocationError(code, portable.value);
    return new InvocationError(code);
  }
  return new InvocationError("ERR_RUNTIME");
}

function toEngineError(error: unknown): AsyncAPIExecutionError {
  if (error instanceof AsyncAPIExecutionError) return error;
  if (error instanceof InvocationError) {
    return new AsyncAPIExecutionError(error.code, error.message, {
      cause: error,
      ...(Object.hasOwn(error, "data")
        ? { details: error.data, detailsPresent: true }
        : {}),
    });
  }
  return new AsyncAPIExecutionError("ERR_RUNTIME", errorMessage(error), { cause: error });
}

function sdkInvocationCause(error: unknown): InvocationError | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof InvocationError) return current;
    seen.add(current);
    current = current.cause;
  }
  return null;
}

function portableAsyncAPIData(
  error: unknown,
): { present: false } | { present: true; value: unknown } {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current instanceof AsyncAPIExecutionError && current.detailsPresent) {
      return { present: true, value: current.details };
    }
    current = current.cause;
  }
  return { present: false };
}

function cloneMetadata(metadata: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(metadata).map(([name, values]) => [name, [...values]]));
}

// ---------------------------------------------------------------------------
// Synthesizer
// ---------------------------------------------------------------------------

/** Synthesizes OBInterface definitions from AsyncAPI 3.x documents. */
export class AsyncAPISynthesizer implements InterfaceSynthesizer, CoverageSynthesizer, SourceInspector {
  /** Returns the binding specifications this synthesizer supports, by exact identifier. */
  bindingSpecs(): BindingSpecInfo[] {
    return [
      { bindingSpec: BINDING_SPEC, description: "AsyncAPI 2.0–2.6 and 3.0–3.1 event-driven APIs" },
    ];
  }

  /** Parses an AsyncAPI document and converts it into an OBInterface. */
  async synthesizeInterface(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<OBInterface> {
    return (await this.synthesizeObserved(input, options)).interface;
  }

  async synthesizeInterfaceWithCoverage(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<SynthesizeResult> {
    const observation = await this.synthesizeObserved(input, options);
    return finalizeSynthesisCoverage(
      observation.interface,
      observation.document ? synthesisCoverage(observation.document, observation.interface) : [],
      true,
    );
  }

  private async synthesizeObserved(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<{ interface: OBInterface; document?: AsyncAPIDocument }> {
    const sources = input.sources ?? [];
    const src = sources.at(0);
    if (src === undefined) {
      return { interface: synthesisSkeleton(input) };
    }
    if (sources.length > 1) {
      throw new MultipleSourcesError();
    }
    if (src.bindingSpec !== BINDING_SPEC) {
      throw new Error(`synthesizer supports exact binding specification ${JSON.stringify(BINDING_SPEC)}, got ${JSON.stringify(src.bindingSpec)}`);
    }
    if (src.outputLocation) validateDocumentAddress(src.outputLocation);
    const location = normalizeAuthoringLocation(src.location);
    const artifactContent = src.content === undefined && src.embed && location
      ? await readAuthoringArtifact(location, options?.signal)
      : src.content;
    const doc = await parseAsyncAPIDocument(location, artifactContent, options);
    const iface = await convertToInterface(location, doc, options, src.bindingSpec);
    // Content-fed synthesis: the emitted source must stay invocable. A
    // source needs location or content; with no location, dropping the
    // provided content would emit neither (mirrors the Go SDK's
    // SynthesizeInterface, spec/binding-specs/asyncapi/openbindings.asyncapi.md: "A synthesized source
    // carries the artifact (location, or embedded content when synthesized
    // from content) so it stays invocable as written.").
    if (artifactContent !== undefined) {
      const entry = iface.sources?.[DEFAULT_SOURCE_NAME];
      if (entry) {
        entry.content = artifactContent;
      }
    }
    return {
      interface: finalizeSynthesis(iface, input, DEFAULT_SOURCE_NAME, src.bindingSpec),
      document: doc,
    };
  }

  /** Lists all bindable targets (operation IDs) from an AsyncAPI source. */
  async inspectSource(
    source: Source,
    options?: { signal?: AbortSignal },
  ): Promise<SourceInspection> {
    const location = normalizeAuthoringLocation(source.location);
    const doc = await parseAsyncAPIDocument(location, source.content, options);
    const targets: SourceInspection["targets"] = [];

    if (doc.operations) {
      // Suggest the same operation key convertToInterface assigns (same
      // sorted iteration and sanitizeKey + uniqueKey de-duplication), so an
      // inspection previews exactly what synthesis names.
      const usedKeys = new Set<string>();
      const bindingSpec = source.bindingSpec === BINDING_SPEC
        ? BINDING_SPEC
        : BINDING_SPEC;
      for (const [opID, asyncOp] of bindableOperationEntries(doc, bindingSpec)) {
        const desc = asyncOp?.description || asyncOp?.summary || undefined;
        const operationKey = uniqueKey(sanitizeKey(opID), usedKeys);
        usedKeys.add(operationKey);
        targets.push({
          ref: operationRef(opID),
          operationKey,
          operation: desc ? { description: desc } : undefined,
        });
      }
    }

    return { targets, exhaustive: true };
  }
}

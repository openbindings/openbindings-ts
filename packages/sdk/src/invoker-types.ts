import type { OBInterface, BindingEntry, JSONSchema, Operation } from "./types.js";
import type { InvokeHooks, InvokeSite, OutputDecoder, ResultClassifier, FieldRouter } from "./hooks.js";

/** Identifies the binding source for invocation. */
export interface InvocationSource {
  bindingSpec: string;
  location?: string;
  content?: unknown;
}

/**
 * Arguments for invoking a resolved binding against a format-specific
 * source. Input messages are NOT part of the args — they flow through the
 * returned {@link Invocation} handle's `write` channel.
 *
 * Runtime prerequisites (credentials, configuration) travel in `context`
 * as opaque well-known fields; a binding that needs context it wasn't
 * given terminates with `CONTEXT_REQUIRED` before any side effect, and
 * resolution happens above the binding (see OperationInvoker's
 * contextResolver). Bindings depend on context data, never on a context
 * store or platform callbacks.
 */
export interface BindingInvocationArgs {
  source: InvocationSource;
  /** Format-specific pointer into the source artifact. Empty when the format doesn't use refs. */
  ref: string;
  /** The selected binding entry. Populated by the operation invoker; optional for direct calls. */
  binding?: BindingEntry;
  context?: Record<string, unknown>;
  /** The containing OBI. Most invokers do not need this; it is used by invokers that invoke sub-operations (e.g., operation graphs). */
  interface?: OBInterface;
  /** Operation input schema, populated by the operation invoker. Enables format-specific invokers to read schema metadata (e.g., const values). */
  inputSchema?: JSONSchema;
  /** External cancellation; converges with the handle's `cancel()`. */
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  /**
   * The consumer hook seam carrier (both tiers snapshotted). Populated by
   * the operation invoker; direct binding-layer callers who want different
   * hooks pass their own (OperationInvoker.snapshotHooks). Null/absent =
   * builtins only.
   */
  hooks?: InvokeHooks | null;
  /**
   * The consultation site (canonical operation key, binding key, format,
   * ref). Populated by the operation invoker; format invokers complete the
   * target where they know it.
   */
  site?: InvokeSite;
}

/**
 * Optional, per-call inputs to `OperationInvoker.invoke`. All fields are
 * usually omitted: invocation context is normally resolved by the invoker's
 * contextResolver via the reactive CONTEXT_REQUIRED path, and the binding is
 * normally selected by the operation-invoker contract's default policy. The
 * operation and interface are not here: the
 * operation comes from the {@link OperationSignature} and the interface is a
 * positional argument, so one signature works against any interface.
 */
export interface InvokeOptions {
  /** Per-call OB invocation-context override (credentials/config as opaque well-known fields). */
  context?: Record<string, unknown>;
  /** When set, bypass the binding selector and use this binding key directly. */
  bindingKey?: string;
  /** External cancellation; converges with the handle's `cancel()`. */
  signal?: AbortSignal;
  /**
   * Per-invocation consumer hooks (specification + configuration = complete
   * invocation): the top decline-chain tier, over the invoker-level hooks,
   * over the format built-in. Each axis declines independently.
   */
  outputDecoder?: OutputDecoder;
  resultClassifier?: ResultClassifier;
  fieldRouter?: FieldRouter;
}

/** Describes a binding source for interface synthesis. */
export interface SynthesizeSource {
  bindingSpec: string;
  name?: string;
  location?: string;
  content?: unknown;
  outputLocation?: string;
  embed?: boolean;
  description?: string;
}

/** Input for synthesizing an OpenBindings interface from format-specific sources. */
export interface SynthesizeInput {
  openbindingsVersion?: string;
  sources?: SynthesizeSource[];
  name?: string;
  version?: string;
  description?: string;
  /**
   * Invoked by synthesizers that encounter non-fatal limitations during
   * interface construction (e.g., a field-name collision the flatten
   * resolves deterministically). The synthesizer still produces a valid
   * interface; the warning surfaces what was lost or approximated.
   * Undefined means warnings are dropped silently. Mirrors the Go SDK's
   * SynthesizeInput.OnWarning.
   */
  onWarning?: (warning: SynthesizerWarning) => void;
}

/**
 * A non-fatal limitation encountered while building an interface from a
 * source. Codes are stable and format-namespaced (e.g.
 * "openapi.param_body_collision"); `path` locates the affected member in
 * dotted notation. Mirrors the Go SDK's SynthesizerWarning.
 */
export interface SynthesizerWarning {
  code: string;
  message: string;
  path?: string;
}

/** Describes a binding specification supported by an invoker, by exact identifier. */
export interface BindingSpecInfo {
  bindingSpec: string;
  description?: string;
}

/** A target within a source document that can be framed as an OpenBindings operation. */
export interface BindableTarget {
  /** The reference string to use in a binding entry. */
  ref: string;
  /** Optional suggested operation key for this target. */
  operationKey?: string;
  /** Optional OpenBindings operation framing for this target. */
  operation?: Operation;
}

/** Result of inspecting a source document for bindable targets. */
export interface SourceInspection {
  /** The list of bindable targets discovered in the source. */
  targets: BindableTarget[];
  /**
   * True when this is the complete list of targets for the source.
   * When false, additional targets may exist that were not enumerated.
   */
  exhaustive: boolean;
}

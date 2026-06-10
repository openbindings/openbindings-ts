import type { OBInterface, BindingEntry, JSONSchema, Operation } from "./types.js";

/** Identifies the binding source for invocation. */
export interface InvocationSource {
  format: string;
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
}

/**
 * Arguments for invoking an OBI operation. The invoker resolves the
 * operation name (OBI-T-12), selects a binding (OBI-T-09), and returns an
 * {@link Invocation} handle; input messages flow through the handle.
 */
export interface OperationInvocationArgs {
  interface: OBInterface;
  operation: string;
  context?: Record<string, unknown>;
  /** When set, bypass the binding selector and use this binding key directly. */
  bindingKey?: string;
  /** External cancellation; converges with the handle's `cancel()`. */
  signal?: AbortSignal;
}

/** Describes a binding source for interface creation. */
export interface CreateSource {
  format: string;
  name?: string;
  location?: string;
  content?: unknown;
  outputLocation?: string;
  embed?: boolean;
  description?: string;
}

/** Input for creating an OpenBindings interface from format-specific sources. */
export interface CreateInput {
  openbindingsVersion?: string;
  sources?: CreateSource[];
  name?: string;
  version?: string;
  description?: string;
}

/** Describes a binding format supported by an invoker. */
export interface FormatInfo {
  token: string;
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

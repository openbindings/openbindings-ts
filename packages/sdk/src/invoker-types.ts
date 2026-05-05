import type { OBInterface, SecurityMethod, JSONSchema, Operation } from "./types.js";
import type { ContextStore, PlatformCallbacks, InvocationOptions } from "./context.js";

export type { InvocationOptions } from "./context.js";

/** Identifies the binding source for invocation. */
export interface InvocationSource {
  format: string;
  location?: string;
  content?: unknown;
}

/**
 * Input for invoking a binding against a format-specific source.
 * The invoker populates `context` from the {@link ContextStore} when available;
 * `store` and `callbacks` let the invoker persist updated context and invoke
 * platform interactions during invocation.
 */
export interface BindingInvocationInput {
  source: InvocationSource;
  ref: string;
  input?: unknown;
  context?: Record<string, unknown>;
  options?: InvocationOptions;
  store?: ContextStore;
  callbacks?: PlatformCallbacks;
  /** Security methods for this binding, populated by the operation invoker from the OBI's security section. */
  security?: SecurityMethod[];
  /** Operation input schema, populated by the operation invoker. Enables format-specific invokers to read schema metadata (e.g., const values). */
  inputSchema?: JSONSchema;
  /** The containing OBI. Most invokers do not need this; it is used by invokers that invoke sub-operations (e.g., operation graphs). */
  interface?: OBInterface;
  fetch?: typeof globalThis.fetch;
}

/** Input for invoking an OBI operation. The invoker resolves the binding internally. */
export interface OperationInvocationInput {
  interface: OBInterface;
  operation: string;
  input?: unknown;
  context?: Record<string, unknown>;
  options?: InvocationOptions;
  /** When set, bypass the binding selector and use this binding key directly. */
  bindingKey?: string;
}

/** The result of an operation invocation. */
export interface InvocationOutput {
  output?: unknown;
  status?: number;
  durationMs?: number;
  error?: InvocationError;
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

/**
 * A single event from a streaming invocation.
 * Unary operations emit one event; streaming operations emit multiple.
 */
export interface StreamEvent {
  data?: unknown;
  error?: InvocationError;
  status?: number;
  durationMs?: number;
}

/** A structured invocation error with a machine-readable code and human-readable message. */
export interface InvocationError {
  code: string;
  message: string;
  details?: unknown;
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

import type { OBInterface, SecurityMethod, JSONSchema } from "./types.js";
import type { ContextStore, PlatformCallbacks, ExecutionOptions } from "./context.js";

export type { ExecutionOptions } from "./context.js";

/** Identifies the binding source for execution. */
export interface ExecuteSource {
  format: string;
  location?: string;
  content?: unknown;
}

/**
 * Input for executing a binding against a format-specific source.
 * The executor populates `context` from the {@link ContextStore} when available;
 * `store` and `callbacks` let the executor persist updated context and invoke
 * platform interactions during execution.
 */
export interface BindingExecutionInput {
  source: ExecuteSource;
  ref: string;
  input?: unknown;
  context?: Record<string, unknown>;
  options?: ExecutionOptions;
  store?: ContextStore;
  callbacks?: PlatformCallbacks;
  /** Security methods for this binding, populated by the operation executor from the OBI's security section. */
  security?: SecurityMethod[];
  /** Operation input schema, populated by the operation executor. Enables format-specific executors to read schema metadata (e.g., const values). */
  inputSchema?: JSONSchema;
  /** The containing OBI. Most executors do not need this; it is used by executors that invoke sub-operations (e.g., operation graphs). */
  interface?: OBInterface;
  fetch?: typeof globalThis.fetch;
}

/** Input for executing an OBI operation. The executor resolves the binding internally. */
export interface OperationExecutionInput {
  interface: OBInterface;
  operation: string;
  input?: unknown;
  context?: Record<string, unknown>;
  options?: ExecutionOptions;
  /** When set, bypass the binding selector and use this binding key directly. */
  bindingKey?: string;
}

/** The result of an operation execution. */
export interface ExecuteOutput {
  output?: unknown;
  status?: number;
  durationMs?: number;
  error?: ExecuteError;
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
 * A single event from a streaming execution.
 * Unary operations emit one event; streaming operations emit multiple.
 */
export interface StreamEvent {
  data?: unknown;
  error?: ExecuteError;
  status?: number;
  durationMs?: number;
}

/** A structured execution error with a machine-readable code and human-readable message. */
export interface ExecuteError {
  code: string;
  message: string;
  details?: unknown;
}

/** Describes a binding format supported by an executor. */
export interface FormatInfo {
  token: string;
  description?: string;
}

/** A single bindable reference within a source document. */
export interface BindableRef {
  /** The reference string to use in a binding entry. */
  ref: string;
  /** Optional human-readable description. */
  description?: string;
}

/** Result of listing bindable refs from a source. */
export interface ListRefsResult {
  /** The list of available bindable references. */
  refs: BindableRef[];
  /**
   * True when this is the complete list of refs for the source.
   * When false, additional refs may exist that were not enumerated.
   */
  exhaustive: boolean;
}

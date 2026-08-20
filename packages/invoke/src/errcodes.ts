/**
 * Invocation error-code constants used by the SDK. Wire values are SCREAMING_SNAKE with an
 * `ERR_` prefix, plus the un-prefixed negotiation signal `CONTEXT_REQUIRED`,
 * matching the `openbindings.binding-invoker` interface where that interface
 * defines them. Only interface-owned lifecycle and negotiation codes have
 * cross-implementation portability by definition. The remaining codes are
 * open SDK conventions, not an exhaustive cross-protocol failure vocabulary;
 * binding specifications and third-party implementations may define others.
 * (One idiom split: wiring errors — unknown operation/binding/source — throw
 * synchronously in TypeScript but surface as pre-errored handles in Go; the
 * local wiring codes below exist so Go-emitted values are documented here.)
 *
 * The lifecycle codes (`ERR_CANCELLED`, `ERR_ALREADY_CONSUMED`, ...) are
 * produced by the SDK's invocation machinery. Other constants document
 * implementation outcomes used by this SDK; exporting them does not give
 * them cross-binding semantics or make them a portable failure taxonomy.
 * Third-party invokers MAY use additional codes.
 */

// ---------------------------------------------------------------------------
// Lifecycle and protocol codes (produced by the invocation machinery)
// ---------------------------------------------------------------------------

/** Invocation was cancelled (caller `cancel()`, abandoned iteration, or an aborted signal). */
export const ERR_CANCELLED = "ERR_CANCELLED";

/** The output sequence was acquired a second time (single-consumer, acquire-once). */
export const ERR_ALREADY_CONSUMED = "ERR_ALREADY_CONSUMED";

/** `single()` observed zero outputs, or short-circuited on a second output. */
export const ERR_EXPECTED_SINGLE = "ERR_EXPECTED_SINGLE";

/** Write after the input side closed (caller `close()` or binding `closeInput()`). Non-terminal. */
export const ERR_INPUT_CLOSED = "ERR_INPUT_CLOSED";

/** The invocation already terminated (closed, errored, or cancelled). */
export const ERR_INVOCATION_CLOSED = "ERR_INVOCATION_CLOSED";

/** A binding that accepts a bounded number of inputs received more. Terminal. */
export const ERR_TOO_MANY_INPUTS = "ERR_TOO_MANY_INPUTS";

/** A required input message never arrived before the input side closed. */
export const ERR_MISSING_INPUT = "ERR_MISSING_INPUT";

/** OpenBindings invocation frame-protocol violation. */
export const ERR_FRAME_PROTOCOL = "ERR_FRAME_PROTOCOL";

/** Binding- or implementation-defined native protocol failure identifier. */
export const ERR_PROTOCOL = "ERR_PROTOCOL";

/** Transport closed without a terminal frame (binding-invoker interface wire protocol). */
export const ERR_TRANSPORT_CLOSED = "ERR_TRANSPORT_CLOSED";

/**
 * Missing runtime context (credentials, configuration). Raised by a binding
 * BEFORE any observable side effect; data carries a ContextRequiredDetails.
 * Un-prefixed: it is a negotiation signal, not a failure of the operation.
 */
export const CONTEXT_REQUIRED = "CONTEXT_REQUIRED";

// ---------------------------------------------------------------------------
// Operation-invoker-owned resolution codes. They are portable when produced
// by that interface and never originate from a binding invocation merely as
// protocol evidence. The TS SDK may surface some before an asynchronous
// handle starts; that API idiom does not change their contract meaning.
// ---------------------------------------------------------------------------

/** The requested operation matches no key or alias on the interface. */
export const ERR_OPERATION_NOT_FOUND = "ERR_OPERATION_NOT_FOUND";

/** A binding references a source not present in the interface. */
export const ERR_UNKNOWN_SOURCE = "ERR_UNKNOWN_SOURCE";

// ---------------------------------------------------------------------------
// SDK implementation codes (not a cross-binding taxonomy)
// ---------------------------------------------------------------------------

/** Ref is malformed or can't be parsed. */
export const ERR_INVALID_REF = "ERR_INVALID_REF";

/** Ref is syntactically valid but doesn't resolve to anything in the source. */
export const ERR_REF_NOT_FOUND = "ERR_REF_NOT_FOUND";

/** Binding source couldn't be loaded or parsed. */
export const ERR_SOURCE_LOAD_FAILED = "ERR_SOURCE_LOAD_FAILED";

/** Source loaded but missing required configuration (e.g., no server URL). */
/** The binding-invoker contract's never-dispatched guarantee: the
 *  invocation was refused before dispatch and no observable interaction
 *  side effect occurred. Emitted ONLY where that guarantee provably holds;
 *  ERR_EXECUTION_FAILED makes no dispatch-state claim. */
export const ERR_REFUSED = "ERR_REFUSED";
export const ERR_SOURCE_CONFIG_ERROR = "ERR_SOURCE_CONFIG_ERROR";

/** Connection to the service couldn't be established. */
export const ERR_CONNECT_FAILED = "ERR_CONNECT_FAILED";

/**
 * Generic unsuccessful completion. This says nothing about protocol category,
 * blame, retryability, side effects, authentication, authorization, or
 * availability.
 */
export const ERR_EXECUTION_FAILED = "ERR_EXECUTION_FAILED";

/** Response received but couldn't be processed (e.g., too large, parse error). */
export const ERR_RESPONSE_ERROR = "ERR_RESPONSE_ERROR";

/** Error during streaming after initial connection. */
export const ERR_STREAM_ERROR = "ERR_STREAM_ERROR";

/** Open extension identifier retained for binding/runtime-specific timeout rules. */
export const ERR_TIMEOUT = "ERR_TIMEOUT";

// ---------------------------------------------------------------------------
// Remaining operation-invoker-owned mechanics
// ---------------------------------------------------------------------------

/** Explicit binding absent, or no invocable binding for the requested operation. */
export const ERR_BINDING_NOT_FOUND = "ERR_BINDING_NOT_FOUND";

/** Several invocable bindings remain and the caller supplied no effective choice. */
export const ERR_BINDING_SELECTION_REQUIRED = "ERR_BINDING_SELECTION_REQUIRED";

/** An operation input or output transform failed. */
export const ERR_TRANSFORM_ERROR = "ERR_TRANSFORM_ERROR";

/** Operation-layer validation failed, including an operation schema claim. */
export const ERR_OPERATION_VALIDATION_FAILED = "ERR_OPERATION_VALIDATION_FAILED";

/** Open extension identifier retained for binding-specific validation rules. */
export const ERR_VALIDATION_FAILED = "ERR_VALIDATION_FAILED";

/**
 * The governing schema graph could not be established (an unresolvable
 * $ref, or a schema that will not compile), so the validation claim could
 * not be EVALUATED at all — reported distinctly from a value mismatch and
 * never papered over with partial validation (OBI-T-16; the
 * openbindings.operation-invoker contract owns this code).
 */
export const ERR_SCHEMA_UNRESOLVED = "ERR_SCHEMA_UNRESOLVED";

/**
 * A typed-invoker boundary failure: a value could not be decoded into (or
 * encoded from) the generated concrete type. Emitted by the Go SDK's typed
 * codegen boundary; documented here for cross-SDK parity and for consumers
 * handling Go-originated values.
 */
export const ERR_TYPE_MISMATCH = "ERR_TYPE_MISMATCH";

/** A generic runtime failure inside a binding implementation. */
export const ERR_RUNTIME = "ERR_RUNTIME";

// ---------------------------------------------------------------------------
// Operation-graph codes
// ---------------------------------------------------------------------------

/**
 * The operation graph exceeded the maximum number of events permitted per
 * execution. Protects against unbounded event amplification from map nodes
 * in cycles.
 */
export const ERR_EVENT_LIMIT_EXCEEDED = "ERR_EVENT_LIMIT_EXCEEDED";

/** An exit node terminated the operation graph execution with an error. */
export const ERR_OPERATION_GRAPH_EXIT = "ERR_OPERATION_GRAPH_EXIT";

/**
 * A binding source declares a format version the invoker refuses (e.g. the
 * operation-graph OG-T-02 rule mirroring OBI-T-04: higher major, or higher
 * minor while pre-1.0). Per-node failure identifiers inside an operation
 * graph (TIMEOUT_EXCEEDED, WRITE_REJECTED, MAP_NOT_ARRAY,
 * TRANSFORM_UNDEFINED) are format error identifiers defined by the
 * operation-graph spec and live in @openbindings/operationgraph, not here.
 */
export const ERR_UNSUPPORTED_FORMAT_VERSION = "ERR_UNSUPPORTED_FORMAT_VERSION";

/**
 * The union of code constants known to this SDK, derived
 * from the constants above so the two never drift. A consumer switching on
 * {@link InvocationError.code} gets exhaustive autocomplete for these. The
 * `code` field itself is typed `InvocationErrorCode | (string & {})`: the
 * `(string & {})` arm admits third-party invoker codes without collapsing the
 * literal suggestions, so known codes still autocomplete while unknown ones
 * still type-check.
 */
export type InvocationErrorCode =
  | typeof ERR_CANCELLED
  | typeof ERR_ALREADY_CONSUMED
  | typeof ERR_EXPECTED_SINGLE
  | typeof ERR_INPUT_CLOSED
  | typeof ERR_INVOCATION_CLOSED
  | typeof ERR_TOO_MANY_INPUTS
  | typeof ERR_MISSING_INPUT
  | typeof ERR_FRAME_PROTOCOL
  | typeof ERR_PROTOCOL
  | typeof ERR_TRANSPORT_CLOSED
  | typeof CONTEXT_REQUIRED
  | typeof ERR_OPERATION_NOT_FOUND
  | typeof ERR_UNKNOWN_SOURCE
  | typeof ERR_INVALID_REF
  | typeof ERR_REF_NOT_FOUND
  | typeof ERR_SOURCE_LOAD_FAILED
  | typeof ERR_SOURCE_CONFIG_ERROR
  | typeof ERR_CONNECT_FAILED
  | typeof ERR_EXECUTION_FAILED
  | typeof ERR_RESPONSE_ERROR
  | typeof ERR_STREAM_ERROR
  | typeof ERR_TIMEOUT
  | typeof ERR_BINDING_NOT_FOUND
  | typeof ERR_BINDING_SELECTION_REQUIRED
  | typeof ERR_TRANSFORM_ERROR
  | typeof ERR_OPERATION_VALIDATION_FAILED
  | typeof ERR_VALIDATION_FAILED
  | typeof ERR_SCHEMA_UNRESOLVED
  | typeof ERR_TYPE_MISMATCH
  | typeof ERR_RUNTIME
  | typeof ERR_EVENT_LIMIT_EXCEEDED
  | typeof ERR_OPERATION_GRAPH_EXIT
  | typeof ERR_UNSUPPORTED_FORMAT_VERSION;

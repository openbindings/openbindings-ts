/**
 * Canonical invocation error codes. Wire values are SCREAMING_SNAKE with an
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
 * produced by the SDK's invocation machinery; the operational codes are
 * SDK conventions for format invokers. Third-party invokers MAY use
 * additional codes.
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

/** Frame-protocol violation (binding-invoker interface wire protocol). */
export const ERR_PROTOCOL = "ERR_PROTOCOL";

/** Transport closed without a terminal frame (binding-invoker interface wire protocol). */
export const ERR_TRANSPORT_CLOSED = "ERR_TRANSPORT_CLOSED";

/**
 * Missing runtime context (credentials, configuration). Raised by a binding
 * BEFORE any observable side effect; details carry a ContextRequiredDetails.
 * Un-prefixed: it is a negotiation signal, not a failure of the operation.
 */
export const CONTEXT_REQUIRED = "CONTEXT_REQUIRED";

// ---------------------------------------------------------------------------
// Local wiring codes (operation-layer resolution failures; never cross the
// wire from a binding). The TS SDK throws typed errors for these instead —
// the constants exist for cross-SDK documentation and for consumers handling
// Go-originated values.
// ---------------------------------------------------------------------------

/** The requested operation matches no key or alias on the interface. */
export const ERR_OPERATION_NOT_FOUND = "ERR_OPERATION_NOT_FOUND";

/** A binding references a source not present in the interface. */
export const ERR_UNKNOWN_SOURCE = "ERR_UNKNOWN_SOURCE";

// ---------------------------------------------------------------------------
// Operational codes (format-invoker conventions)
// ---------------------------------------------------------------------------

/** The service rejected the provided credentials (e.g., HTTP 401, gRPC Unauthenticated). */
export const ERR_AUTH_REQUIRED = "ERR_AUTH_REQUIRED";

/** Authenticated but not authorized (e.g., HTTP 403). */
export const ERR_PERMISSION_DENIED = "ERR_PERMISSION_DENIED";

/** Ref is malformed or can't be parsed. */
export const ERR_INVALID_REF = "ERR_INVALID_REF";

/** Ref is syntactically valid but doesn't resolve to anything in the source. */
export const ERR_REF_NOT_FOUND = "ERR_REF_NOT_FOUND";

/** Binding source couldn't be loaded or parsed. */
export const ERR_SOURCE_LOAD_FAILED = "ERR_SOURCE_LOAD_FAILED";

/** Source loaded but missing required configuration (e.g., no server URL). */
export const ERR_SOURCE_CONFIG_ERROR = "ERR_SOURCE_CONFIG_ERROR";

/** Connection to the service couldn't be established. */
export const ERR_CONNECT_FAILED = "ERR_CONNECT_FAILED";

/** Call was made but the service returned an error. */
export const ERR_EXECUTION_FAILED = "ERR_EXECUTION_FAILED";

/** Response received but couldn't be processed (e.g., too large, parse error). */
export const ERR_RESPONSE_ERROR = "ERR_RESPONSE_ERROR";

/** Error during streaming after initial connection. */
export const ERR_STREAM_ERROR = "ERR_STREAM_ERROR";

/** Operation timed out. */
export const ERR_TIMEOUT = "ERR_TIMEOUT";

/**
 * The service was reached but refused the request as retryable (e.g. HTTP
 * 429/502/503, gRPC `UNAVAILABLE`/`RESOURCE_EXHAUSTED`). Distinct from
 * {@link ERR_CONNECT_FAILED} in that the server answered. Retryable with
 * backoff; `effects` is `"none"` when the refusal proves non-execution.
 */
export const ERR_UNAVAILABLE = "ERR_UNAVAILABLE";

/** No binding found for the requested operation. */
export const ERR_BINDING_NOT_FOUND = "ERR_BINDING_NOT_FOUND";

/** Several invocable bindings remain and the caller supplied no effective choice. */
export const ERR_BINDING_SELECTION_REQUIRED = "ERR_BINDING_SELECTION_REQUIRED";

/** Transform evaluation failed. */
export const ERR_TRANSFORM_ERROR = "ERR_TRANSFORM_ERROR";

/**
 * A value failed validation against the operation's declared input or
 * output schema — a validation claim evaluated per the core's claim
 * semantics (OBI-T-16) and found FALSE.
 */
export const ERR_VALIDATION_FAILED = "ERR_VALIDATION_FAILED";

/**
 * The governing schema graph could not be established (an unresolvable
 * $ref, or a schema that will not compile), so the validation claim could
 * not be EVALUATED at all — reported distinctly from a value mismatch and
 * never papered over with partial validation (OBI-T-16; the
 * openbindings.operation-invoker contract names this convention code).
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
 * The union of every canonical code an invocation handle can carry, derived
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
  | typeof ERR_PROTOCOL
  | typeof ERR_TRANSPORT_CLOSED
  | typeof CONTEXT_REQUIRED
  | typeof ERR_OPERATION_NOT_FOUND
  | typeof ERR_UNKNOWN_SOURCE
  | typeof ERR_AUTH_REQUIRED
  | typeof ERR_PERMISSION_DENIED
  | typeof ERR_INVALID_REF
  | typeof ERR_REF_NOT_FOUND
  | typeof ERR_SOURCE_LOAD_FAILED
  | typeof ERR_SOURCE_CONFIG_ERROR
  | typeof ERR_CONNECT_FAILED
  | typeof ERR_EXECUTION_FAILED
  | typeof ERR_RESPONSE_ERROR
  | typeof ERR_STREAM_ERROR
  | typeof ERR_TIMEOUT
  | typeof ERR_UNAVAILABLE
  | typeof ERR_BINDING_NOT_FOUND
  | typeof ERR_BINDING_SELECTION_REQUIRED
  | typeof ERR_TRANSFORM_ERROR
  | typeof ERR_VALIDATION_FAILED
  | typeof ERR_SCHEMA_UNRESOLVED
  | typeof ERR_TYPE_MISMATCH
  | typeof ERR_RUNTIME
  | typeof ERR_EVENT_LIMIT_EXCEEDED
  | typeof ERR_OPERATION_GRAPH_EXIT
  | typeof ERR_UNSUPPORTED_FORMAT_VERSION;

/**
 * Returns the SDK's open code for concrete HTTP unsuccessful completion. The
 * binding-invoker interface deliberately does not project status numbers into
 * a closed cross-protocol failure or retry taxonomy. The status may be retained
 * separately on an explicit diagnostic surface.
 */
export function httpErrorCode(_status: number): string {
  return ERR_EXECUTION_FAILED;
}

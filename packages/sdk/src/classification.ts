/**
 * The InvocationError classification model of the `openbindings.binding-invoker`
 * interface: the normative `category` axis every error branches on, and the
 * `effects` marker that gates safe retry. Both derive from the error `code`
 * through the single canonical map below, so the classification lives in
 * exactly one place and a test pins that map to the interface's documented
 * code→category table (the only thing that can drift from the contract).
 *
 * This file MUST stay behaviorally identical to the Go SDK's `classification.go`:
 * the same category for every code, the same effects for every dispatch path.
 */

import {
  CONTEXT_REQUIRED,
  ERR_ALREADY_CONSUMED,
  ERR_AUTH_REQUIRED,
  ERR_BINDING_NOT_FOUND,
  ERR_CANCELLED,
  ERR_CONNECT_FAILED,
  ERR_EVENT_LIMIT_EXCEEDED,
  ERR_EXECUTION_FAILED,
  ERR_EXPECTED_SINGLE,
  ERR_INPUT_CLOSED,
  ERR_INVALID_REF,
  ERR_INVOCATION_CLOSED,
  ERR_MISSING_INPUT,
  ERR_OPERATION_GRAPH_EXIT,
  ERR_OPERATION_NOT_FOUND,
  ERR_PERMISSION_DENIED,
  ERR_PROTOCOL,
  ERR_REF_NOT_FOUND,
  ERR_RESPONSE_ERROR,
  ERR_RUNTIME,
  ERR_SCHEMA_UNRESOLVED,
  ERR_SOURCE_CONFIG_ERROR,
  ERR_SOURCE_LOAD_FAILED,
  ERR_STREAM_ERROR,
  ERR_TIMEOUT,
  ERR_TOO_MANY_INPUTS,
  ERR_TRANSFORM_ERROR,
  ERR_TRANSPORT_CLOSED,
  ERR_TYPE_MISMATCH,
  ERR_UNAVAILABLE,
  ERR_UNKNOWN_SOURCE,
  ERR_UNSUPPORTED_FORMAT_VERSION,
  ERR_VALIDATION_FAILED,
} from "./errcodes.js";

/**
 * The normative classification axis every InvocationError carries. A fixed,
 * closed set for this interface's major version; a consumer that meets an
 * unknown value treats it as `"permanent"`. An application (or the operation
 * invoker) branches on the category without knowing which binding family or
 * which specific code produced the failure.
 */
export type Category =
  | "context"
  | "auth"
  | "cancelled"
  | "transient"
  | "service"
  | "validation"
  | "protocol"
  | "permanent";

/**
 * The invoker's honest report of whether the call's side effects may have
 * taken hold — the marker that makes "transient ⇒ retry" safe. Meaningful only
 * where retry is in question (the `transient` and `service` categories). An
 * error that omits it is treated as `"possible"`: a consumer never auto-retries
 * it and never infers `"none"` from silence.
 *
 * - `none`: provably did not take hold (connection failed before send; a server
 *   that definitively refused before executing; a pre-dispatch challenge).
 * - `possible`: dispatched, then the transport dropped or it timed out.
 * - `definite`: a success/partial output was seen, or the server signaled it acted.
 */
export type Effects = "none" | "possible" | "definite";

/**
 * The ONE canonical code→category map. Mirrors the binding-invoker README
 * "Standard error codes" registry table exactly; a table test
 * (classification.test.ts) pins every registry code to its documented category
 * so this map cannot silently drift from the contract.
 *
 * A code absent here is classified `"permanent"` by {@link categoryForCode}
 * (the README's unknown-category fallback), but every code THIS SDK emits
 * appears here — including the one format-specific promotion, TIMEOUT_EXCEEDED,
 * which the operation-graph engine raises as a terminal invocation error for a
 * node that blows its budget.
 */
export const CODE_CATEGORY: Record<string, Category> = {
  // Normative codes (named by the contract).
  [CONTEXT_REQUIRED]: "context",
  [ERR_PROTOCOL]: "protocol",
  [ERR_TRANSPORT_CLOSED]: "transient",
  [ERR_CANCELLED]: "cancelled",
  [ERR_VALIDATION_FAILED]: "validation",
  [ERR_BINDING_NOT_FOUND]: "permanent",
  // Convention codes (recommended spellings for a category member).
  [ERR_AUTH_REQUIRED]: "auth",
  [ERR_PERMISSION_DENIED]: "auth",
  [ERR_INVALID_REF]: "permanent",
  [ERR_REF_NOT_FOUND]: "permanent",
  [ERR_SCHEMA_UNRESOLVED]: "validation",
  [ERR_SOURCE_LOAD_FAILED]: "permanent",
  [ERR_SOURCE_CONFIG_ERROR]: "permanent",
  [ERR_CONNECT_FAILED]: "transient",
  [ERR_EXECUTION_FAILED]: "service",
  [ERR_RESPONSE_ERROR]: "service",
  [ERR_STREAM_ERROR]: "transient",
  [ERR_TIMEOUT]: "transient",
  [ERR_UNAVAILABLE]: "transient",
  [ERR_OPERATION_NOT_FOUND]: "permanent",
  [ERR_UNKNOWN_SOURCE]: "permanent",
  [ERR_TRANSFORM_ERROR]: "validation",
  [ERR_INPUT_CLOSED]: "protocol",
  [ERR_INVOCATION_CLOSED]: "protocol",
  [ERR_TOO_MANY_INPUTS]: "protocol",
  [ERR_MISSING_INPUT]: "protocol",
  [ERR_ALREADY_CONSUMED]: "protocol",
  [ERR_EXPECTED_SINGLE]: "protocol",
  [ERR_TYPE_MISMATCH]: "validation",
  [ERR_EVENT_LIMIT_EXCEEDED]: "permanent",
  [ERR_OPERATION_GRAPH_EXIT]: "service",
  [ERR_UNSUPPORTED_FORMAT_VERSION]: "permanent",
  [ERR_RUNTIME]: "permanent",
  // Format-specific promotion: the operation-graph per-node budget timeout
  // (TIMEOUT_EXCEEDED) can surface as a terminal invocation error. A timeout
  // is transient, never permanent.
  TIMEOUT_EXCEEDED: "transient",
};

/**
 * Returns the canonical category for a code, defaulting to `"permanent"` for
 * any code not in the map (the interface's unknown-category fallback: a
 * consumer that cannot place a code treats it as terminal).
 */
export function categoryForCode(code: string): Category {
  return CODE_CATEGORY[code] ?? "permanent";
}

/**
 * The honest side-effect report for the transport-level transient codes this
 * SDK emits, consulted only when an emission site did not set effects itself. A
 * connection that failed before send provably did not take effect; a timeout, a
 * mid-stream error, or a transport drop all happened after dispatch, so the
 * call may have taken hold. This is why format packages need no per-site
 * effects wiring for these codes: the InvocationError constructor fills them.
 */
const CODE_EFFECTS_DEFAULT: Record<string, Effects> = {
  [ERR_CONNECT_FAILED]: "none", // never dispatched
  [ERR_TIMEOUT]: "possible", // dispatched, no conclusive response
  [ERR_STREAM_ERROR]: "possible", // failed after the stream opened
  [ERR_TRANSPORT_CLOSED]: "possible", // transport dropped after send
  TIMEOUT_EXCEEDED: "possible", // node dispatched, then blew its budget
};

/**
 * The default effects for a code when an emission site left it unset, or
 * `undefined` when the code carries no default (absent effects reads as
 * `"possible"` per the contract).
 */
export function defaultEffectsForCode(code: string): Effects | undefined {
  return CODE_EFFECTS_DEFAULT[code];
}

/**
 * What an HTTP error status proves about side effects. A 429 or 503 is the
 * server refusing the request before it executed (rate-limited / unavailable),
 * so the call provably did not take hold — `"none"` licenses a backoff-retry.
 * Every other status returns `undefined`: a 5xx that may already have executed
 * is conservatively treated as `"possible"`, and 401/403 (auth) carry no
 * effects. Mirrors the Go SDK's `httpErrorEffects`.
 */
export function httpErrorEffects(status: number): Effects | undefined {
  return status === 429 || status === 503 ? "none" : undefined;
}

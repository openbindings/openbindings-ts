/**
 * Standard error codes for binding executor results. These enable
 * protocol-agnostic error handling by the operation executor and
 * application code. Binding executors SHOULD use these codes in
 * ExecuteError.code.
 *
 * These are SDK conventions, not spec requirements. Third-party
 * executors MAY use different codes.
 */

/** Authentication needed (e.g., HTTP 401, gRPC Unauthenticated). Retryable with credentials. */
export const ERR_AUTH_REQUIRED = "auth_required";

/** Authenticated but not authorized (e.g., HTTP 403). */
export const ERR_PERMISSION_DENIED = "permission_denied";

/** Ref is malformed or can't be parsed. */
export const ERR_INVALID_REF = "invalid_ref";

/** Ref is syntactically valid but doesn't resolve to anything in the source. */
export const ERR_REF_NOT_FOUND = "ref_not_found";

/** Input doesn't match the expected schema. */
export const ERR_INVALID_INPUT = "invalid_input";

/** Binding source couldn't be loaded or parsed. */
export const ERR_SOURCE_LOAD_FAILED = "source_load_failed";

/** Source loaded but missing required configuration (e.g., no server URL). */
export const ERR_SOURCE_CONFIG_ERROR = "source_config_error";

/** Connection to the service couldn't be established. */
export const ERR_CONNECT_FAILED = "connect_failed";

/** Call was made but the service returned an error. */
export const ERR_EXECUTION_FAILED = "execution_failed";

/** Response received but couldn't be processed (e.g., too large, parse error). */
export const ERR_RESPONSE_ERROR = "response_error";

/** Error during streaming after initial connection. */
export const ERR_STREAM_ERROR = "stream_error";

/** Operation timed out. */
export const ERR_TIMEOUT = "timeout";

/** Operation was cancelled by the caller. */
export const ERR_CANCELLED = "cancelled";

/** No binding found for the requested operation. */
export const ERR_BINDING_NOT_FOUND = "binding_not_found";

/** Transform evaluation failed. */
export const ERR_TRANSFORM_ERROR = "transform_error";

/**
 * Maps an HTTP status code to a standard error code.
 * Shared utility for format executors that handle HTTP responses.
 */
export function httpErrorCode(status: number): string {
  if (status === 401) return ERR_AUTH_REQUIRED;
  if (status === 403) return ERR_PERMISSION_DENIED;
  return ERR_EXECUTION_FAILED;
}

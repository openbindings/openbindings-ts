/** The binding-specification identifier this package implements (exact and opaque, core §6). */
export const BINDING_SPEC = "openbindings.operation-graph@1";

/**
 * Spec-defined error identifiers (SCREAMING_SNAKE_CASE, per the format
 * spec's Error identifiers table). They appear as the `error` member of
 * in-graph error events and as terminal-error codes for failures the format
 * defines. Failures originating in an inner invocation surface the inner
 * terminal error verbatim instead.
 */
export const TIMEOUT_EXCEEDED = "TIMEOUT_EXCEEDED";
export const WRITE_REJECTED = "WRITE_REJECTED";
export const MAP_NOT_ARRAY = "MAP_NOT_ARRAY";
export const TRANSFORM_UNDEFINED = "TRANSFORM_UNDEFINED";

/**
 * The format version this implementation supports. OG-T-02 (mirroring the
 * core spec's OBI-T-04): refuse a higher major version or one below the
 * supported minimum (pre-1.0, both bounds apply to minors), and refuse
 * prereleases absent declared support.
 */
export const SUPPORTED_MAJOR = 0;
export const SUPPORTED_MINOR = 2;

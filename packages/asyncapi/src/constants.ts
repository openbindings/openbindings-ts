/** The binding-specification identifier this package implements (exact and opaque, core §6). */
export const BINDING_SPEC = "openbindings.asyncapi@1";

/** Default source key used when generating OBInterface entries from AsyncAPI docs. */
export const DEFAULT_SOURCE_NAME = "asyncapi";

/**
 * Synthetic field tagged onto a security-list entry's `$ref` node (in
 * util.ts's tagSecurityRefNames, before the shared dereferencer runs) and
 * read back off the resolved scheme (in invoke.ts's nameForScheme) to
 * recover the components.securitySchemes key a `$ref` resolved through
 * (rule A: "name — the scheme name as the source artifact declares it").
 * Necessary because the shared dereferencer (deref.ts) resolves internal
 * refs against the ORIGINAL document closure, not the clone it walks and
 * returns, so the resolved scheme object is never reference-equal to
 * anything reachable from the final document — identity-based name
 * recovery (the approach OpenAPI-style code would reach for first) does
 * not work here. Tagging survives the dereferencer's merge-copy path
 * (extra keys on a `$ref` node are copied onto the resolved object when
 * absent there), so this rides through untouched. Never present on an
 * inline scheme (no `$ref`) or an external `$ref` (no local
 * components.securitySchemes key to name).
 */
export const REF_NAME_TAG = "x-ob-asyncapi-ref-name";

/** The current binding-specification identifier (exact and opaque, core §6). */
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

/**
 * Synthetic field tagged onto each entry of the raw document's `channels`
 * map (its own map key) before the shared dereferencer runs, and read back
 * off an operation's resolved `channel` object to recover the channel's
 * name — the address configuration point's refusals name the refusing
 * channel (ASYNC-P-04), and dereferencing has replaced the operation's
 * channel `$ref` with the resolved object by then. Same survival mechanics
 * as {@link REF_NAME_TAG}, except the tag rides the TARGET object itself
 * (the name is the channel's own map key, not a property of any one
 * reference), so every `$ref` resolving to the channel sees it.
 */
export const CHANNEL_NAME_TAG = "x-ob-asyncapi-channel-name";

/** Synthetic original external operation/reply channel reference. */
export const CHANNEL_REF_TAG = "x-ob-asyncapi-channel-ref";

/**
 * Synthetic field tagged onto each entry of the raw document's `servers`
 * map (its own map key) before the shared dereferencer runs, and read back
 * off a channel's resolved `servers` subset entries to recover each
 * member's servers-map key. The effective server set (ASYNC-P-04) is
 * key-addressable — consumer `configuration.server` selects a member by
 * its servers-map key ({"key": ...}, the §9.2 pinned form) — and
 * dereferencing would otherwise erase the keys.
 */
export const SERVER_NAME_TAG = "x-ob-asyncapi-server-name";

/** Synthetic channel-message map key preserved through dereferencing. */
export const MESSAGE_NAME_TAG = "x-ob-asyncapi-message-name";

/** Synthetic original operation/reply message reference for coverage identity. */
export const MESSAGE_REF_TAG = "x-ob-asyncapi-message-ref";

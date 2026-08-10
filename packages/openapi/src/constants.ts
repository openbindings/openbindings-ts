/** The current binding-specification identifier (exact and opaque, core §6). */
export const BINDING_SPEC = "openbindings.openapi@3";

/** Immutable revision-1 compatibility identifier. */
export const LEGACY_BINDING_SPEC = "openbindings.openapi@1";

/** Immutable collision-preserving revision-2 identifier. */
export const BINDING_SPEC_V2 = "openbindings.openapi@2";

/** Current OpenAPI binding revision. */
export const BINDING_SPEC_V3 = BINDING_SPEC;

/** Revisions whose abstract input surface uses collision-preserving routes. */
export function hasRoutedInputs(bindingSpec: string): boolean {
  return bindingSpec === BINDING_SPEC_V2 || bindingSpec === BINDING_SPEC_V3;
}

/** Default source name used when registering an OpenAPI source in an OBInterface. */
export const DEFAULT_SOURCE_NAME = "openapi";

/** Set of valid HTTP methods recognized in OpenAPI path items. */
export const VALID_METHODS = new Set([
  "get", "post", "put", "patch", "delete", "head", "options", "trace",
]);

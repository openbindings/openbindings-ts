/** The current binding-specification identifier (exact and opaque, core §6). */
export const BINDING_SPEC = "openbindings.openapi@5";

/** Immutable revision-1 compatibility identifier. */
export const LEGACY_BINDING_SPEC = "openbindings.openapi@1";

/** Immutable collision-preserving revision-2 identifier. */
export const BINDING_SPEC_V2 = "openbindings.openapi@2";

/** Immutable request-media-fidelity revision. */
export const BINDING_SPEC_V3 = "openbindings.openapi@3";

/** Immutable response-carriage-fidelity revision. */
export const BINDING_SPEC_V4 = "openbindings.openapi@4";

/** Current dynamic-object-carriage revision. */
export const BINDING_SPEC_V5 = BINDING_SPEC;

/** Revisions whose abstract input surface uses collision-preserving routes. */
export function hasRoutedInputs(bindingSpec: string): boolean {
  return bindingSpec === BINDING_SPEC_V2
    || bindingSpec === BINDING_SPEC_V3
    || bindingSpec === BINDING_SPEC_V4
    || bindingSpec === BINDING_SPEC_V5;
}

/** Revisions using the RFC 9110 request-media and carriage rules introduced by revision 3. */
export function hasMediaFidelity(bindingSpec: string): boolean {
  return bindingSpec === BINDING_SPEC_V3
    || bindingSpec === BINDING_SPEC_V4
    || bindingSpec === BINDING_SPEC_V5;
}

/** Revisions that admit response media ranges and exact raw-byte output carriage. */
export function hasResponseFidelity(bindingSpec: string): boolean {
  return bindingSpec === BINDING_SPEC_V4 || bindingSpec === BINDING_SPEC_V5;
}

/** Revisions that preserve explicitly dynamic object bodies as one application value. */
export function hasDynamicObjectCarriage(bindingSpec: string): boolean {
  return bindingSpec === BINDING_SPEC_V5;
}

/** Default source name used when registering an OpenAPI source in an OBInterface. */
export const DEFAULT_SOURCE_NAME = "openapi";

/** Set of valid HTTP methods recognized in OpenAPI path items. */
export const VALID_METHODS = new Set([
  "get", "post", "put", "patch", "delete", "head", "options", "trace",
]);

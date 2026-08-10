import {
  OPENAPI_PROFILE_BASE,
  OPENAPI_PROFILE_DYNAMIC_OBJECT,
  OPENAPI_PROFILE_FULL,
  OPENAPI_PROFILE_MEDIA,
  OPENAPI_PROFILE_RESPONSE,
  OPENAPI_PROFILE_ROUTED,
  OPENAPI_PROFILE_WHOLE_JSON,
  withInputRouteMarker,
  type OpenAPIExecutionProfile,
} from "@openbindings/openapi-client/engine";

/** The current binding-specification identifier (exact and opaque, core §6). */
export const BINDING_SPEC = "openbindings.openapi@7";
export const LEGACY_BINDING_SPEC = "openbindings.openapi@1";
export const BINDING_SPEC_V2 = "openbindings.openapi@2";
export const BINDING_SPEC_V3 = "openbindings.openapi@3";
export const BINDING_SPEC_V4 = "openbindings.openapi@4";
export const BINDING_SPEC_V5 = "openbindings.openapi@5";
export const BINDING_SPEC_V6 = "openbindings.openapi@6";
export const BINDING_SPEC_V7 = BINDING_SPEC;

const PROFILES: Readonly<Record<string, OpenAPIExecutionProfile>> = Object.freeze({
  [LEGACY_BINDING_SPEC]: withInputRouteMarker(OPENAPI_PROFILE_BASE, LEGACY_BINDING_SPEC),
  [BINDING_SPEC_V2]: withInputRouteMarker(OPENAPI_PROFILE_ROUTED, BINDING_SPEC_V2),
  [BINDING_SPEC_V3]: withInputRouteMarker(OPENAPI_PROFILE_MEDIA, BINDING_SPEC_V3),
  [BINDING_SPEC_V4]: withInputRouteMarker(OPENAPI_PROFILE_RESPONSE, BINDING_SPEC_V4),
  [BINDING_SPEC_V5]: withInputRouteMarker(OPENAPI_PROFILE_DYNAMIC_OBJECT, BINDING_SPEC_V5),
  [BINDING_SPEC_V6]: withInputRouteMarker(OPENAPI_PROFILE_WHOLE_JSON, BINDING_SPEC_V6),
  [BINDING_SPEC_V7]: withInputRouteMarker(OPENAPI_PROFILE_FULL, BINDING_SPEC_V7),
});

/** Maps an immutable binding contract to artifact-engine capabilities. */
export function profileForBindingSpec(bindingSpec: string): OpenAPIExecutionProfile {
  const profile = PROFILES[bindingSpec];
  if (!profile) throw new Error(`unsupported OpenAPI binding specification ${JSON.stringify(bindingSpec)}`);
  return profile;
}

export function hasRoutedInputs(bindingSpec: string): boolean {
  return profileForBindingSpec(bindingSpec).routedInputs;
}
export function hasMediaFidelity(bindingSpec: string): boolean {
  return profileForBindingSpec(bindingSpec).mediaFidelity;
}
export function hasResponseFidelity(bindingSpec: string): boolean {
  return profileForBindingSpec(bindingSpec).responseFidelity;
}
export function hasDynamicObjectCarriage(bindingSpec: string): boolean {
  return profileForBindingSpec(bindingSpec).dynamicObjectCarriage;
}
export function hasWholeJSONCarriage(bindingSpec: string): boolean {
  return profileForBindingSpec(bindingSpec).wholeJSONCarriage;
}
export function hasSchemaOmittedOAS30ByteCarriage(bindingSpec: string): boolean {
  return profileForBindingSpec(bindingSpec).schemaOmittedOAS30ByteCarriage;
}

export { VALID_METHODS } from "@openbindings/openapi-client/analysis";

/** Default source name used when registering an OpenAPI source in an OBInterface. */
export const DEFAULT_SOURCE_NAME = "openapi";

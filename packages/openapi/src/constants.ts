import {
  OPENAPI_PROFILE_FULL,
  withInputRouteMarker,
  type OpenAPIExecutionProfile,
} from "@openbindings/openapi-client/engine";

/** The current binding-specification identifier (exact and opaque, core §6). */
export const BINDING_SPEC = "openbindings.openapi@1";

const PROFILES: Readonly<Record<string, OpenAPIExecutionProfile>> = Object.freeze({
  [BINDING_SPEC]: withInputRouteMarker(OPENAPI_PROFILE_FULL, BINDING_SPEC),
});

/** Maps the unreleased binding candidate to artifact-engine capabilities. */
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

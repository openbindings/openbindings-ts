import {
  OPENAPI_PROFILE_FULL,
  withInputRouteMarker,
  type OpenAPIExecutionProfile,
} from "@openbindings/openapi-client/engine";

/** Exact registered OpenAPI-family tokens (core §6). */
export const BINDING_SPEC_OPENAPI_20 = "openbindings.openapi-2.0@1";
export const BINDING_SPEC_OPENAPI_30 = "openbindings.openapi-3.0@1";
export const BINDING_SPEC_OPENAPI_31 = "openbindings.openapi-3.1@1";
export const BINDING_SPEC_OPENAPI_32 = "openbindings.openapi-3.2@1";

/** Portable refusal code for an absent, unknown, or unwarranted exact token. */
export const ERR_UNSUPPORTED_BINDING_SPEC = "ERR_UNSUPPORTED_BINDING_SPEC";

interface OpenAPIBindingSpecRegistration {
  requestImplemented: boolean;
  responseComplete: boolean;
  editions: ReadonlySet<string>;
}

const OPENAPI_BINDING_SPEC_REGISTRY: Readonly<Record<string, OpenAPIBindingSpecRegistration>> =
  Object.freeze({
    [BINDING_SPEC_OPENAPI_20]: {
      requestImplemented: true,
      responseComplete: true,
      editions: new Set(["2.0"]),
    },
    [BINDING_SPEC_OPENAPI_30]: {
      requestImplemented: true,
      responseComplete: true,
      editions: new Set(["3.0.0", "3.0.1", "3.0.2", "3.0.3", "3.0.4"]),
    },
    [BINDING_SPEC_OPENAPI_31]: {
      requestImplemented: true,
      responseComplete: true,
      editions: new Set(["3.1.0", "3.1.1", "3.1.2"]),
    },
    [BINDING_SPEC_OPENAPI_32]: {
      requestImplemented: true,
      responseComplete: false,
      editions: new Set(["3.2.0"]),
    },
  });

const PROFILES: Readonly<Record<string, OpenAPIExecutionProfile>> = Object.freeze({
  [BINDING_SPEC_OPENAPI_20]: withInputRouteMarker(OPENAPI_PROFILE_FULL, BINDING_SPEC_OPENAPI_20),
  [BINDING_SPEC_OPENAPI_30]: withInputRouteMarker(OPENAPI_PROFILE_FULL, BINDING_SPEC_OPENAPI_30),
  [BINDING_SPEC_OPENAPI_31]: withInputRouteMarker(OPENAPI_PROFILE_FULL, BINDING_SPEC_OPENAPI_31),
  [BINDING_SPEC_OPENAPI_32]: withInputRouteMarker(OPENAPI_PROFILE_FULL, BINDING_SPEC_OPENAPI_32),
});

export function isImplementedOpenAPIBindingSpec(bindingSpec: string): boolean {
  return OPENAPI_BINDING_SPEC_REGISTRY[bindingSpec]?.responseComplete === true;
}

export function isRequestImplementedOpenAPIBindingSpec(bindingSpec: string): boolean {
  return OPENAPI_BINDING_SPEC_REGISTRY[bindingSpec]?.requestImplemented === true;
}

export function unsupportedBindingSpecMessage(bindingSpec: string): string {
  const suffix = bindingSpec === ""
    ? ": name an exact OpenAPI family token in Source.BindingSpec"
    : "";
  return `${ERR_UNSUPPORTED_BINDING_SPEC}: binding specification ${JSON.stringify(bindingSpec)} is not implemented${suffix}`;
}

/** Maps an exact implemented token to artifact-engine capabilities. */
export function profileForBindingSpec(bindingSpec: string): OpenAPIExecutionProfile {
  const profile = PROFILES[bindingSpec];
  if (!profile) throw new Error(unsupportedBindingSpecMessage(bindingSpec));
  return profile;
}

export function checkAcceptedOpenAPIEdition(bindingSpec: string, edition: unknown): void {
  const registration = OPENAPI_BINDING_SPEC_REGISTRY[bindingSpec];
  if (!registration?.requestImplemented) throw new Error(unsupportedBindingSpecMessage(bindingSpec));
  if (typeof edition !== "string" || !registration.editions.has(edition)) {
    throw new Error(
      `document edition ${JSON.stringify(edition ?? "")} is not admitted by binding specification ${JSON.stringify(bindingSpec)}`,
    );
  }
}

export function bindingSpecForOpenAPIEdition(edition: string): string | undefined {
  if (OPENAPI_BINDING_SPEC_REGISTRY[BINDING_SPEC_OPENAPI_20]!.editions.has(edition)) {
    return BINDING_SPEC_OPENAPI_20;
  }
  if (OPENAPI_BINDING_SPEC_REGISTRY[BINDING_SPEC_OPENAPI_30]!.editions.has(edition)) {
    return BINDING_SPEC_OPENAPI_30;
  }
  if (OPENAPI_BINDING_SPEC_REGISTRY[BINDING_SPEC_OPENAPI_31]!.editions.has(edition)) {
    return BINDING_SPEC_OPENAPI_31;
  }
  if (OPENAPI_BINDING_SPEC_REGISTRY[BINDING_SPEC_OPENAPI_32]!.editions.has(edition)) {
    return BINDING_SPEC_OPENAPI_32;
  }
  return undefined;
}

export function openAPIRule(bindingSpec: string, rule: string): string {
  if (bindingSpec === BINDING_SPEC_OPENAPI_20) return `OAPI20-${rule}`;
  if (bindingSpec === BINDING_SPEC_OPENAPI_30) return `OAPI30-${rule}`;
  if (bindingSpec === BINDING_SPEC_OPENAPI_31) return `OAPI31-${rule}`;
  if (bindingSpec === BINDING_SPEC_OPENAPI_32) return `OAPI32-${rule}`;
  return `OAPI-${rule}`;
}

export function hasRoutedInputs(bindingSpec: string): boolean {
  return isRequestImplementedOpenAPIBindingSpec(bindingSpec);
}
export function hasMediaFidelity(bindingSpec: string): boolean {
  return isRequestImplementedOpenAPIBindingSpec(bindingSpec);
}
export function hasResponseFidelity(bindingSpec: string): boolean {
  return OPENAPI_BINDING_SPEC_REGISTRY[bindingSpec]?.responseComplete === true;
}
export function hasDynamicObjectCarriage(bindingSpec: string): boolean {
  return isRequestImplementedOpenAPIBindingSpec(bindingSpec);
}
export function hasWholeJSONCarriage(bindingSpec: string): boolean {
  return isRequestImplementedOpenAPIBindingSpec(bindingSpec);
}
export function hasSchemaOmittedOAS30ByteCarriage(bindingSpec: string): boolean {
  return isRequestImplementedOpenAPIBindingSpec(bindingSpec);
}

export { VALID_METHODS } from "@openbindings/openapi-client/analysis";

/** Default source name used when registering an OpenAPI source in an OBInterface. */
export const DEFAULT_SOURCE_NAME = "openapi";

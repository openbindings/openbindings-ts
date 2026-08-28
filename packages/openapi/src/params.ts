export {
  MissingPathParamError,
  effectiveParameters,
  queryEscape,
  routeInput,
  routeParameter,
  serializationMethod,
  serializeParamContent,
  serializePathValue,
  serializeHeaderValue,
  serializeQueryValue,
  serializeMultipartValue,
  serializeCookieValue,
  primitiveString,
  asArray,
  asObject,
  encodePathValue,
  type RoutedInput,
} from "@openbindings/openapi-client/analysis";
import {
  resolvedParameterStyleLaneUndefinedExpansionMember as parameterStyleLaneUndefinedExpansionMember,
  resolvedStyleLaneUndefinedExpansionParam as styleLaneUndefinedExpansionParam,
  validateResolvedParameterSerialization as validateNativeParameterSerialization,
} from "@openbindings/openapi-client/analysis";

import type { OpenAPIParameter } from "./types.js";
import { BINDING_SPEC_OPENAPI_30, BINDING_SPEC_OPENAPI_31 } from "./constants.js";
export {
  parameterStyleLaneUndefinedExpansionMember,
  styleLaneUndefinedExpansionParam,
};

/** Defaults to the 3.1 declaration dialect for direct helper callers. */
export function validateParameterSerialization(
  parameter: OpenAPIParameter,
  oas30 = false,
): void {
  validateNativeParameterSerialization(parameter, oas30);
}

/** Returns the first exact (in,name) identity declared more than once. */
export function duplicateEffectiveParameterIdentity(params: OpenAPIParameter[]): string | undefined {
  const seen = new Set<string>();
  for (const parameter of params) {
    const inValue = parameter.in ?? "";
    const name = parameter.name ?? "";
    const identity = `${inValue}\u0000${name}`;
    if (seen.has(identity)) return `${inValue}/${name}`;
    seen.add(identity);
  }
  return undefined;
}

/**
 * Returns a case-distinct header name that aliases an earlier HTTP field.
 * Routed caller keys can distinguish locations, but HTTP field names remain
 * case-insensitive and therefore cannot represent two such destinations.
 */
export function caseFoldedHeaderCollision(params: OpenAPIParameter[]): string | undefined {
  const seen = new Map<string, string>();
  for (const parameter of params) {
    if (parameter.in !== "header" || typeof parameter.name !== "string") continue;
    const folded = parameter.name.toLowerCase();
    const previous = seen.get(folded);
    if (previous !== undefined && previous !== parameter.name) return parameter.name;
    seen.set(folded, parameter.name);
  }
  return undefined;
}

/** Family-specific requestBody method semantics. Method is lower-case. */
export function requestBodyIgnoredForBindingSpec(bindingSpec: string, method: string): boolean {
  if (bindingSpec === BINDING_SPEC_OPENAPI_31) return method === "trace";
  if (bindingSpec === BINDING_SPEC_OPENAPI_30) {
    return ["get", "head", "delete", "options", "trace"].includes(method);
  }
  return true;
}

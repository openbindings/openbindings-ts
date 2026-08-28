import {
  checkPathTemplateDeclaration as checkNativePathTemplateDeclaration,
  contentFormNullIsElided as nativeContentFormNullIsElided,
  convertParameterScalars,
  effectiveParameterDeclarationRows,
  equivalentPathTemplateCollision,
  formStyleCookieMultiValueParameter,
  formStyleCookieMultiValueProof,
  malformedEffectiveParameter as malformedNativeParameter,
  prepareEncodingStylePropertyValue as prepareNativeEncodingStylePropertyValue,
  prepareResolvedEncodingView,
  validateCompletedOpenAPIURL,
  resolvedParameterStyleLaneUndefinedExpansionMember as parameterStyleLaneUndefinedExpansionMember,
  prepareSchemaParameterValue as prepareNativeParameterValue,
  resolvedStyleLaneUndefinedExpansionMember as styleLaneUndefinedExpansionMember,
  resolvedStyleLaneUndefinedExpansionParam as styleLaneUndefinedExpansionParam,
  validateResolvedParameterSerialization as validateNativeParameterSerialization,
  type BodyPlan,
  type OpenAPIParameterConverter,
} from "@openbindings/openapi-client/analysis";
import { BINDING_SPEC_OPENAPI_30, BINDING_SPEC_OPENAPI_31 } from "./constants.js";
import type {
  OpenAPIDocument,
  OpenAPIParameter,
} from "./types.js";

export type ParameterConversion = OpenAPIParameterConverter;

export {
  convertParameterScalars,
  effectiveParameterDeclarationRows,
  equivalentPathTemplateCollision,
  formStyleCookieMultiValueParameter,
  formStyleCookieMultiValueProof,
  parameterStyleLaneUndefinedExpansionMember,
  styleLaneUndefinedExpansionMember,
  styleLaneUndefinedExpansionParam,
};

/** The binding token selects the standalone client's OpenAPI edition rule. */
export function malformedEffectiveParameter(
  parameters: OpenAPIParameter[],
  bindingSpec: string,
): string | undefined {
  if (!supportedBindingSpec(bindingSpec)) return undefined;
  return malformedNativeParameter(parameters);
}

export function validateParameterSerializationForBinding(
  parameter: OpenAPIParameter,
  oas30: boolean,
): void {
  validateNativeParameterSerialization(parameter, oas30);
}

export function checkPathTemplateDeclaration(
  pathTemplate: string,
  parameters: OpenAPIParameter[],
  bindingSpec: string,
): string | undefined {
  if (!supportedBindingSpec(bindingSpec)) return undefined;
  return checkNativePathTemplateDeclaration(
    pathTemplate,
    parameters,
    bindingSpec === BINDING_SPEC_OPENAPI_31,
  );
}

export function prepareSchemaParameterValue(
  parameter: OpenAPIParameter | undefined,
  value: unknown,
  _bindingSpec: string,
  conversion: ParameterConversion | undefined,
): ReturnType<typeof prepareNativeParameterValue> {
  return prepareNativeParameterValue(parameter, value, conversion);
}

/** §5.2's one source-scope exclusion, intentionally distinct from load refusal. */
export function sourceExclusionReason(
  document: OpenAPIDocument,
  bindingSpec: string,
): string | undefined {
  if (bindingSpec !== BINDING_SPEC_OPENAPI_31 || !Object.hasOwn(document, "jsonSchemaDialect")) {
    return undefined;
  }
  if (document.jsonSchemaDialect === "https://spec.openapis.org/oas/3.1/dialect/base") {
    return undefined;
  }
  return `whole-source exclusion: root jsonSchemaDialect ${JSON.stringify(document.jsonSchemaDialect)} is not the incorporated OpenAPI 3.1 base dialect`;
}

export function prepareEncodingStylePropertyValue(
  plan: BodyPlan | undefined,
  name: string,
  value: unknown,
  bindingSpec: string,
  conversion: ParameterConversion | undefined,
): unknown {
  return prepareNativeEncodingStylePropertyValue(
    plan,
    name,
    value,
    bindingSpec === BINDING_SPEC_OPENAPI_30,
    conversion,
  );
}

export function contentFormNullIsElided(
  plan: BodyPlan | undefined,
  name: string,
  value: unknown,
  bindingSpec: string,
): boolean {
  return nativeContentFormNullIsElided(
    plan,
    name,
    value,
    bindingSpec === BINDING_SPEC_OPENAPI_30,
  );
}

export function prepareEngineEncodingView(plans: BodyPlan[]): void {
  prepareResolvedEncodingView(plans);
}

export function validateCompletedURL(raw: string): void {
  validateCompletedOpenAPIURL(raw);
}

function supportedBindingSpec(bindingSpec: string): boolean {
  return bindingSpec === BINDING_SPEC_OPENAPI_30 || bindingSpec === BINDING_SPEC_OPENAPI_31;
}

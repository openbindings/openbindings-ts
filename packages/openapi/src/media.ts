// Compatibility surface: existing adapter imports continue to resolve while
// OpenAPI wire planning and serialization are owned by the standalone client.
export * from "@openbindings/openapi-client/analysis";

import {
  buildResolvedMultipartBody,
  configuredResolvedPropertyMedia,
  planResolvedRequestBodies,
  prepareResolvedPropertyMediaView,
  requiredPropertyMediaNames as requiredNames,
  plansRequirePropertyMedia as plansRequire,
  selectPropertyMedia as selectMedia,
  type BodyPlan,
  type OpenAPIDocument,
  type OpenAPIMediaType,
  type OpenAPIResolvedBodyPlan,
} from "@openbindings/openapi-client/analysis";

export type AdapterBodyPlan = OpenAPIResolvedBodyPlan;

export function planRequestBodies(
  ...args: Parameters<typeof planResolvedRequestBodies>
): ReturnType<typeof planResolvedRequestBodies> {
  return planResolvedRequestBodies(...args);
}

export function requiredPropertyMediaNames(plan: BodyPlan): string[] {
  return requiredNames(plan);
}

export function plansRequirePropertyMedia(plans: readonly BodyPlan[]): boolean {
  return plansRequire(plans);
}

export function buildMultipartBody(
  doc: OpenAPIDocument,
  media: OpenAPIMediaType | null,
  fields: Record<string, unknown>,
  revision3 = false,
  dynamicProperties = false,
): FormData {
  return buildResolvedMultipartBody(doc, media, fields, revision3, dynamicProperties);
}

export function prepareEnginePropertyMediaView(
  plans: readonly BodyPlan[],
  context: Record<string, unknown> | undefined,
): void {
  prepareResolvedPropertyMediaView(plans, propertyMediaMap(context));
}

export function configuredPropertyMedia(
  plan: BodyPlan,
  context: Record<string, unknown> | undefined,
): Record<string, string> {
  return configuredResolvedPropertyMedia(plan, propertyMediaMap(context));
}

export function selectPropertyMedia(
  plan: AdapterBodyPlan,
  name: string,
  choice: string,
): string {
  return selectMedia(plan, name, choice);
}

function propertyMediaMap(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const configuration = asRecord(context?.configuration);
  const raw = configuration?.propertyMedia;
  if (raw === undefined || raw === null) return undefined;
  const value = asRecord(raw);
  if (!value) throw new Error("configuration.propertyMedia must be an object keyed by property name");
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

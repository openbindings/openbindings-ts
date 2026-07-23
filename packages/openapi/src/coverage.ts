import type {
  OBInterface,
  SynthesisCoverageEntry,
} from "@openbindings/sdk";
import type {
  OpenAPIDocument,
  OpenAPIOperation,
  OpenAPIPathItem,
} from "./types.js";
import {
  candidateCollides,
  planRequestBodies,
} from "./media.js";
import { effectiveParameters } from "./params.js";
import {
  HTTP_METHODS,
} from "./synthesize.js";
import {
  buildJsonPointerRef,
  codePointCompare,
} from "./util.js";

/**
 * Inventories path operations, request-media alternatives, callbacks, and
 * webhooks observed during OpenAPI synthesis. Parameter serialization,
 * response selection, server resolution, and security requirements are
 * incorporated behavior of their represented target rather than separate
 * interaction units.
 */
export function openAPISynthesisCoverage(
  doc: OpenAPIDocument | undefined,
  iface: OBInterface,
): SynthesisCoverageEntry[] {
  if (!doc) return [];
  const byRef = new Map<string, { operationKey: string; ref: string }>();
  for (const binding of Object.values(iface.bindings ?? {})) {
    if (binding.ref) byRef.set(binding.ref, { operationKey: binding.operation, ref: binding.ref });
  }

  const entries: SynthesisCoverageEntry[] = [];
  for (const [path, rawPathItem] of sortedEntries(doc.paths)) {
    if (!rawPathItem || typeof rawPathItem !== "object") continue;
    const pathItem: OpenAPIPathItem = rawPathItem;
    for (const method of HTTP_METHODS) {
      const rawOperation = pathItem[method];
      if (!rawOperation || typeof rawOperation !== "object") continue;
      const operation = rawOperation as OpenAPIOperation;
      const ref = buildJsonPointerRef(path, method);
      const identity = byRef.get(ref);
      if (!identity) {
        entries.push({
          sourceIndex: 0,
          sourceRef: ref,
          scope: "target",
          status: "implementation-unsupported",
          reasonCode: "openapi.missing_emitted_binding",
          message: "the synthesizer returned without emitting this admitted paths operation",
        });
        continue;
      }
      entries.push({
        sourceIndex: 0,
        sourceRef: ref,
        scope: "target",
        status: "represented",
        operationKey: identity.operationKey,
        bindingRef: identity.ref,
      });
      entries.push(...requestMediaCoverage(operation, pathItem, identity));
      entries.push(...callbackCoverage(operation, ref));
    }
  }
  entries.push(...webhookCoverage(doc));
  return entries;
}

function requestMediaCoverage(
  operation: OpenAPIOperation,
  pathItem: OpenAPIPathItem,
  identity: { operationKey: string; ref: string },
): SynthesisCoverageEntry[] {
  const content = operation.requestBody?.content;
  if (!content || Object.keys(content).length === 0) return [];
  const params = effectiveParameters(pathItem, operation);
  let planError: unknown;
  let plans: ReturnType<typeof planRequestBodies> = [];
  try {
    plans = planRequestBodies(operation);
  } catch (error: unknown) {
    planError = error;
  }
  const planned = new Set(plans.map((plan) => plan.mediaKey));
  const represented = new Set(
    plans.filter((plan) => !candidateCollides(params, plan)).map((plan) => plan.mediaKey),
  );
  return Object.keys(content).sort(codePointCompare).map((mediaType): SynthesisCoverageEntry => {
    const sourceRef = `${identity.ref}/requestBody/content/${escapeJSONPointerToken(mediaType)}`;
    if (represented.has(mediaType)) {
      return {
        sourceIndex: 0,
        sourceRef,
        scope: "alternative",
        status: "represented",
        operationKey: identity.operationKey,
        bindingRef: identity.ref,
      };
    }
    const collision = planned.has(mediaType);
    return {
      sourceIndex: 0,
      sourceRef,
      scope: "alternative",
      status: "excluded",
      reasonCode: collision ? "openapi.flattening_collision" : "openapi.request_media_excluded",
      rule: collision ? "OAPI-P-03" : "OAPI-P-04",
      message: collision
        ? "request media alternative collides with an independently declared parameter in revision 1's flattened boundary"
        : errorMessage(planError) || "request media alternative has no faithful revision-1 carriage",
      details: { mediaType },
    };
  });
}

function callbackCoverage(operation: OpenAPIOperation, parentRef: string): SynthesisCoverageEntry[] {
  const callbacks = operation["callbacks"];
  if (!callbacks || typeof callbacks !== "object" || Array.isArray(callbacks)) return [];
  const entries: SynthesisCoverageEntry[] = [];
  for (const [name, rawCallback] of sortedEntries(callbacks as Record<string, unknown>)) {
    if (!rawCallback || typeof rawCallback !== "object" || Array.isArray(rawCallback)) continue;
    for (const [expression, rawPathItem] of sortedEntries(rawCallback as Record<string, unknown>)) {
      if (!rawPathItem || typeof rawPathItem !== "object" || Array.isArray(rawPathItem)) continue;
      for (const method of HTTP_METHODS) {
        if (!(method in (rawPathItem as Record<string, unknown>))) continue;
        entries.push(excludedReverseInteraction(
          `${parentRef}/callbacks/${escapeJSONPointerToken(name)}/${escapeJSONPointerToken(expression)}/${method}`,
        ));
      }
    }
  }
  return entries;
}

function webhookCoverage(doc: OpenAPIDocument): SynthesisCoverageEntry[] {
  const webhooks = doc["webhooks"];
  if (webhooks === undefined) return [];
  if (!webhooks || typeof webhooks !== "object" || Array.isArray(webhooks)) {
    return [{
      sourceIndex: 0,
      sourceRef: "#/webhooks",
      scope: "target",
      status: "invalid",
      reasonCode: "openapi.invalid_webhooks",
      message: "the OpenAPI 3.1 webhooks member is not an object",
    }];
  }
  const entries: SynthesisCoverageEntry[] = [];
  for (const [name, rawPathItem] of sortedEntries(webhooks as Record<string, unknown>)) {
    if (!rawPathItem || typeof rawPathItem !== "object" || Array.isArray(rawPathItem)) {
      entries.push({
        sourceIndex: 0,
        sourceRef: `#/webhooks/${escapeJSONPointerToken(name)}`,
        scope: "target",
        status: "invalid",
        reasonCode: "openapi.invalid_webhook",
        message: "webhook path item is not an object",
      });
      continue;
    }
    for (const method of HTTP_METHODS) {
      if (!(method in (rawPathItem as Record<string, unknown>))) continue;
      entries.push(excludedReverseInteraction(`#/webhooks/${escapeJSONPointerToken(name)}/${method}`));
    }
  }
  return entries;
}

function excludedReverseInteraction(sourceRef: string): SynthesisCoverageEntry {
  return {
    sourceIndex: 0,
    sourceRef,
    scope: "target",
    status: "excluded",
    reasonCode: "openapi.reverse_direction",
    rule: "OAPI-D-03",
    message: "callbacks and webhooks describe service-to-consumer requests outside openbindings.openapi@1",
  };
}

function sortedEntries<T>(value: Record<string, T> | undefined): Array<[string, T]> {
  return Object.entries(value ?? {}).sort(([a], [b]) => codePointCompare(a, b));
}

function escapeJSONPointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error === undefined) return "";
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown synthesis error";
  }
}

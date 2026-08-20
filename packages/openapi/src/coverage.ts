import type { OBInterface } from "@openbindings/core";
import type { SynthesisCoverageEntry } from "@openbindings/synthesize";
import type {
  OpenAPIDocument,
  OpenAPIOperation,
  OpenAPIPathItem,
} from "./types.js";
import {
  candidateCollides,
  normalizedMediaCollisions,
  planRequestBodies,
} from "./media.js";
import { effectiveParameters } from "./params.js";
import {
  HTTP_METHODS,
  type UnrealizableTarget,
} from "./synthesize.js";
import {
  buildJsonPointerRef,
  codePointCompare,
} from "./util.js";
import { resolveServer } from "./servers.js";
import {
  INVALID_UNIT_REASON_CODE,
  floorDefectDetails,
  floorInvalidAlternativeMessage,
  floorInvalidTargetMessage,
  floorOpVerdict,
  floorProjectionMessage,
  type AcceptanceFloor,
  type FloorOp,
} from "@openbindings/openapi-client/analysis";
import {
  BINDING_SPEC,
  hasMediaFidelity,
  hasRoutedInputs,
  profileForBindingSpec,
} from "./constants.js";

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
  unrealizable?: ReadonlyMap<string, UnrealizableTarget>,
  floor?: AcceptanceFloor,
): SynthesisCoverageEntry[] {
  if (!doc) return [];
  const byRef = new Map<string, { operationKey: string; ref: string }>();
  for (const binding of Object.values(iface.bindings ?? {})) {
    if (binding.ref) byRef.set(binding.ref, { operationKey: binding.operation, ref: binding.ref });
  }
  const source = Object.values(iface.sources ?? {})
    .find((candidate) => candidate.bindingSpec === BINDING_SPEC
      || candidate.bindingSpec === BINDING_SPEC
      || candidate.bindingSpec === BINDING_SPEC
      || candidate.bindingSpec === BINDING_SPEC
      || candidate.bindingSpec === BINDING_SPEC
      || candidate.bindingSpec === BINDING_SPEC);
  const sourceLocation = source?.location ?? "";
  const bindingSpec = source?.bindingSpec ?? BINDING_SPEC;

  // The walk is driven from the UNION of the loaded document's path×method
  // inventory and the acceptance floor's raw-tree inventory (block 8d design
  // §3): a ladder-invalid operation may be absent from the loaded document
  // (confined) or present (a loadable defect); either way its invalid entry
  // is owed. Deterministic order: sorted paths × the HTTP_METHODS order.
  const pathSet = new Set<string>();
  for (const path of Object.keys(doc.paths ?? {})) pathSet.add(path);
  if (floor) for (const ref of floor.opOrder) pathSet.add(floor.ops.get(ref)!.path);

  const entries: SynthesisCoverageEntry[] = [];
  for (const path of [...pathSet].sort(codePointCompare)) {
    const rawPathItem = doc.paths?.[path];
    const pathItem: OpenAPIPathItem | undefined = rawPathItem && typeof rawPathItem === "object" ? rawPathItem : undefined;
    for (const method of HTTP_METHODS) {
      const rawOperation = pathItem?.[method];
      const loadedOperation = rawOperation && typeof rawOperation === "object" ? (rawOperation as OpenAPIOperation) : undefined;
      const ref = buildJsonPointerRef(path, method);
      const verdict = floorOpVerdict(floor, ref);
      if (!loadedOperation && !verdict) continue;
      if (verdict && verdict.disposition === "invalid") {
        // A ladder-invalid target: one invalid target entry carrying the
        // owning unit and its defects, then the operation's projection
        // entries.
        entries.push({
          sourceIndex: 0,
          sourceRef: ref,
          scope: "target",
          status: "invalid",
          reasonCode: INVALID_UNIT_REASON_CODE,
          message: floorInvalidTargetMessage(verdict.defects.length),
          details: { defects: floorDefectDetails(verdict.defects) },
        });
        entries.push(...floorProjectionEntries(verdict));
        continue;
      }
      if (!loadedOperation) {
        // Raw-inventory-only and not ladder-invalid: nothing the loaded
        // document can account further.
        continue;
      }
      const operation = loadedOperation;
      const identity = byRef.get(ref);
      if (!identity) {
        // Tolerant synthesis skipped this operation with a recorded,
        // spec-governed reason: a per-operation exclusion, not an
        // implementation defect. Anything else genuinely missing remains
        // an implementation invariant violation.
        const skipped = unrealizable?.get(ref);
        if (skipped) {
          entries.push({
            sourceIndex: 0,
            sourceRef: ref,
            scope: "target",
            status: "excluded",
            reasonCode: skipped.reasonCode,
            rule: skipped.rule,
            message: skipped.message,
          });
          // An excluded target is still ADDRESSED; its ladder-invalid
          // request media alternatives and projection entries are owed
          // regardless.
          entries.push(...floorInvalidAlternativeEntries(verdict));
          entries.push(...floorProjectionEntries(verdict));
        } else {
          entries.push({
            sourceIndex: 0,
            sourceRef: ref,
            scope: "target",
            status: "implementation-unsupported",
            reasonCode: "openapi.missing_emitted_binding",
            message: "the synthesizer returned without emitting this admitted paths operation",
          });
        }
        continue;
      }
      entries.push({
        sourceIndex: 0,
        sourceRef: ref,
        scope: "target",
        status: "represented",
        operationKey: identity.operationKey,
        bindingRef: identity.ref,
        requirements: [
          ...serverRequirements(doc, pathItem!, operation, sourceLocation),
          ...requestMediaTargetRequirements(operation, pathItem!, bindingSpec, doc.openapi),
        ],
      });
      entries.push(...requestMediaCoverage(operation, pathItem!, identity, bindingSpec, doc.openapi, verdict));
      entries.push(...floorProjectionEntries(verdict));
      entries.push(...callbackCoverage(operation, ref));
    }
  }
  entries.push(...webhookCoverage(doc));
  return entries;
}

/** Renders a ladder-invalid or excluded operation's invalid request media alternatives. */
function floorInvalidAlternativeEntries(verdict: FloorOp | undefined): SynthesisCoverageEntry[] {
  if (!verdict || verdict.altOrder.length === 0) return [];
  return verdict.altOrder.map((altRef): SynthesisCoverageEntry => {
    const defects = verdict.invalidAlternatives.get(altRef) ?? [];
    return {
      sourceIndex: 0,
      sourceRef: altRef,
      scope: "alternative",
      status: "invalid",
      reasonCode: INVALID_UNIT_REASON_CODE,
      message: floorInvalidAlternativeMessage(defects.length),
      details: {
        defects: floorDefectDetails(defects),
        mediaType: unescapeJSONPointerToken(altRef.slice(altRef.lastIndexOf("/") + 1)),
      },
    };
  });
}

/**
 * Renders one projection-scope entry per unit whose emitted closure reaches,
 * or whose response rungs record, invalid positions that cost it nothing.
 */
function floorProjectionEntries(verdict: FloorOp | undefined): SynthesisCoverageEntry[] {
  if (!verdict || verdict.projOrder.length === 0) return [];
  return verdict.projOrder.map((unit): SynthesisCoverageEntry => {
    const defects = verdict.projections.get(unit) ?? [];
    return {
      sourceIndex: 0,
      sourceRef: unit,
      scope: "projection",
      status: "invalid",
      reasonCode: INVALID_UNIT_REASON_CODE,
      message: floorProjectionMessage(defects.length),
      details: { defects: floorDefectDetails(defects) },
    };
  });
}

function unescapeJSONPointerToken(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function requestMediaTargetRequirements(
  operation: OpenAPIOperation,
  pathItem: OpenAPIPathItem,
  bindingSpec: string,
  openapiVersion: string | undefined,
): string[] {
  if (!hasMediaFidelity(bindingSpec) || operation.requestBody?.required !== true) return [];
  try {
    const params = effectiveParameters(pathItem, operation);
    const admissible = planRequestBodies(operation, { profile: profileForBindingSpec(bindingSpec), openapiVersion })
      .filter((plan) => hasRoutedInputs(bindingSpec) || !candidateCollides(params, plan));
    return admissible.length > 0 && admissible.every((plan) => plan.range)
      ? ["configuration.requestMedia"]
      : [];
  } catch {
    return [];
  }
}

function serverRequirements(
  doc: OpenAPIDocument,
  pathItem: OpenAPIPathItem,
  operation: OpenAPIOperation,
  sourceLocation: string,
): string[] {
  try {
    resolveServer(doc, pathItem, operation, undefined, sourceLocation);
    return [];
  } catch {
    return ["configuration.server"];
  }
}

function requestMediaCoverage(
  operation: OpenAPIOperation,
  pathItem: OpenAPIPathItem,
  identity: { operationKey: string; ref: string },
  bindingSpec: string,
  openapiVersion: string | undefined,
  verdict: FloorOp | undefined,
): SynthesisCoverageEntry[] {
  const content = operation.requestBody?.content;
  if (!content || Object.keys(content).length === 0) return [];
  const params = effectiveParameters(pathItem, operation);
  let planError: unknown;
  let plans: ReturnType<typeof planRequestBodies> = [];
  try {
    plans = planRequestBodies(operation, { profile: profileForBindingSpec(bindingSpec), openapiVersion });
  } catch (error: unknown) {
    planError = error;
  }
  // §9.2's normalized collision confines to the colliding parsed identity:
  // the colliding keys are excluded alternatives naming that identity, and the
  // map's non-colliding siblings stay represented beside them.
  const colliding = normalizedMediaCollisions(content, hasMediaFidelity(bindingSpec));
  const planned = new Set(plans.map((plan) => plan.mediaKey));
  const represented = new Set(
    plans
      .filter((plan) => hasRoutedInputs(bindingSpec) || !candidateCollides(params, plan))
      .map((plan) => plan.mediaKey),
  );
  return Object.keys(content).sort(codePointCompare).map((mediaType): SynthesisCoverageEntry => {
    const sourceRef = `${identity.ref}/requestBody/content/${escapeJSONPointerToken(mediaType)}`;
    const invalidDefects = verdict?.invalidAlternatives.get(sourceRef);
    if (invalidDefects) {
      // The ladder invalidates this alternative: `invalid`, not `excluded`
      // -- the unit is malformed under its upstream authority, not declined
      // by the revision.
      return {
        sourceIndex: 0,
        sourceRef,
        scope: "alternative",
        status: "invalid",
        reasonCode: INVALID_UNIT_REASON_CODE,
        message: floorInvalidAlternativeMessage(invalidDefects.length),
        details: {
          defects: floorDefectDetails(invalidDefects),
          mediaType,
        },
      };
    }
    if (represented.has(mediaType)) {
      const entry: SynthesisCoverageEntry = {
        sourceIndex: 0,
        sourceRef,
        scope: "alternative",
        status: "represented",
        operationKey: identity.operationKey,
        bindingRef: identity.ref,
      };
      if (hasMediaFidelity(bindingSpec) && plans.some((plan) => plan.mediaKey === mediaType && plan.range)) {
        entry.requirements = ["configuration.requestMedia"];
      }
      return entry;
    }
    const collision = planned.has(mediaType);
    const collidingIdentity = colliding.get(mediaType);
    let message: string;
    if (collision) {
      message = "request media alternative collides with an independently declared parameter in the candidate's application boundary";
    } else if (collidingIdentity !== undefined) {
      message = `request media alternative denotes the parsed media identity ${collidingIdentity}, which another declaration in this content map also denotes; no selection may land on a normalized-colliding identity`;
    } else {
      message = errorMessage(planError) || "request media alternative has no faithful candidate carriage";
    }
    return {
      sourceIndex: 0,
      sourceRef,
      scope: "alternative",
      status: "excluded",
      reasonCode: collision ? "openapi.flattening_collision" : "openapi.request_media_excluded",
      rule: collision ? "OAPI-P-03" : "OAPI-P-04",
      message,
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

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
  requiredPropertyMediaNames,
} from "./media.js";
import { effectiveParameters } from "./params.js";
import {
  HTTP_METHODS,
  type UnrealizableTarget,
} from "./synthesize.js";
import {
  buildJsonPointerSelector,
  codePointCompare,
} from "./util.js";
import {
  ConfigRequired,
  eligibleServers,
  resolveServer,
  type ServerEntry,
} from "./servers.js";
import {
  effectiveSecurityRequirements,
  securityAlternativeUsable,
  securityCoverageRequirements,
} from "./security.js";
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
  hasMediaFidelity,
  hasRoutedInputs,
  isImplementedOpenAPIBindingSpec,
  openAPIRule,
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
  const bySelector = new Map<string, { operationKey: string; selector: string }>();
  for (const binding of Object.values(iface.bindings ?? {})) {
    if (binding.selector) bySelector.set(binding.selector, { operationKey: binding.operation, selector: binding.selector });
  }
  const source = Object.values(iface.sources ?? {})
    .find((candidate) => isImplementedOpenAPIBindingSpec(candidate.bindingSpec));
  // Coverage cannot make a family claim without an exact warranted source.
  if (!source) return [];
  const sourceLocation = source?.location ?? "";
  const bindingSpec = source.bindingSpec;

  // The walk is driven from the UNION of the loaded document's path×method
  // inventory and the acceptance floor's raw-tree inventory (block 8d design
  // §3): a ladder-invalid operation may be absent from the loaded document
  // (confined) or present (a loadable defect); either way its invalid entry
  // is owed. Deterministic order: sorted paths × the HTTP_METHODS order.
  const pathSet = new Set<string>();
  for (const path of Object.keys(doc.paths ?? {})) pathSet.add(path);
  if (floor) for (const selector of floor.opOrder) pathSet.add(floor.ops.get(selector)!.path);

  const entries: SynthesisCoverageEntry[] = [];
  for (const path of [...pathSet].sort(codePointCompare)) {
    const rawPathItem = doc.paths?.[path];
    const pathItem: OpenAPIPathItem | undefined = rawPathItem && typeof rawPathItem === "object" ? rawPathItem : undefined;
    for (const method of HTTP_METHODS) {
      const rawOperation = pathItem?.[method];
      const loadedOperation = rawOperation && typeof rawOperation === "object" ? (rawOperation as OpenAPIOperation) : undefined;
      const selector = buildJsonPointerSelector(path, method);
      const verdict = floorOpVerdict(floor, selector);
      if (!loadedOperation && !verdict) continue;
      if (verdict && verdict.disposition === "invalid") {
        // A ladder-invalid target: one invalid target entry carrying the
        // owning unit and its defects, then the operation's projection
        // entries.
        entries.push({
          sourceIndex: 0,
          sourceRef: selector,
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
      const identity = bySelector.get(selector);
      if (!identity) {
        // Tolerant synthesis skipped this operation with a recorded,
        // spec-governed reason: a per-operation exclusion, not an
        // implementation defect. Anything else genuinely missing remains
        // an implementation invariant violation.
        const skipped = unrealizable?.get(selector);
        if (skipped) {
          entries.push({
            sourceIndex: 0,
            sourceRef: selector,
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
            sourceRef: selector,
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
        sourceRef: selector,
        scope: "target",
        status: "represented",
        operationKey: identity.operationKey,
        bindingSelector: identity.selector,
        requirements: [
          ...serverRequirements(doc, pathItem!, operation, sourceLocation),
          ...securityCoverageRequirements(doc, operation, effectiveParameters(pathItem!, operation)),
          ...requestMediaTargetRequirements(operation, pathItem!, bindingSpec, doc.openapi),
        ],
      });
      entries.push(...serverAlternativeCoverage(
        doc,
        pathItem!,
        operation,
        selector,
        identity.operationKey,
        bindingSpec,
        sourceLocation,
      ));
      entries.push(...securityAlternativeCoverage(
        doc,
        operation,
        effectiveParameters(pathItem!, operation),
        selector,
        identity.operationKey,
        bindingSpec,
      ));
      entries.push(...requestMediaCoverage(operation, pathItem!, identity, bindingSpec, doc.openapi, verdict));
      entries.push(...floorProjectionEntries(verdict));
      entries.push(...callbackCoverage(operation, selector));
    }
  }
  entries.push(...webhookCoverage(doc));
  return entries;
}

/** Renders a ladder-invalid or excluded operation's invalid request media alternatives. */
function floorInvalidAlternativeEntries(verdict: FloorOp | undefined): SynthesisCoverageEntry[] {
  if (!verdict || verdict.altOrder.length === 0) return [];
  return verdict.altOrder.map((altSelector): SynthesisCoverageEntry => {
    const defects = verdict.invalidAlternatives.get(altSelector) ?? [];
    return {
      sourceIndex: 0,
      sourceRef: altSelector,
      scope: "alternative",
      status: "invalid",
      reasonCode: INVALID_UNIT_REASON_CODE,
      message: floorInvalidAlternativeMessage(defects.length),
      details: {
        defects: floorDefectDetails(defects),
        mediaType: unescapeJSONPointerToken(altSelector.slice(altSelector.lastIndexOf("/") + 1)),
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
    if (admissible.length === 1 && requiredPropertyMediaNames(admissible[0]!).length > 0) {
      return ["configuration.propertyMedia"];
    }
    return admissible.some((plan) => !plan.range && !plan.unsupported)
      ? []
      : admissible.some((plan) => plan.range && !plan.unsupported)
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
  } catch (error: unknown) {
    return error instanceof ConfigRequired ? ["configuration.server"] : [];
  }
}

function serverAlternativeCoverage(
  document: OpenAPIDocument,
  pathItem: OpenAPIPathItem,
  operation: OpenAPIOperation,
  selector: string,
  operationKey: string,
  bindingSpec: string,
  sourceLocation: string,
): SynthesisCoverageEntry[] {
  const declaration = effectiveServerDeclaration(document, pathItem, operation, selector);
  if (!declaration) return [];
  const entries: SynthesisCoverageEntry[] = [];
  for (const [index, server] of declaration.servers.entries()) {
    try {
      eligibleServers([server], document.openapi ?? "", sourceLocation);
    } catch (error: unknown) {
      entries.push({
        sourceIndex: 0,
        sourceRef: `${declaration.prefix}/${index}`,
        scope: "alternative",
        status: "excluded",
        reasonCode: "openapi.server_url_excluded",
        rule: openAPIRule(bindingSpec, "P-04"),
        message: error instanceof Error ? error.message : String(error),
        operationKey,
        bindingSelector: selector,
      });
    }
  }
  return entries;
}

function effectiveServerDeclaration(
  document: OpenAPIDocument,
  pathItem: OpenAPIPathItem,
  operation: OpenAPIOperation,
  selector: string,
): { servers: ServerEntry[]; prefix: string } | null {
  const operationServers = declaredServers(operation.servers);
  if (operationServers.length > 0) return { servers: operationServers, prefix: `${selector}/servers` };
  const pathServers = declaredServers(pathItem.servers);
  if (pathServers.length > 0) {
    return { servers: pathServers, prefix: `${selector.slice(0, selector.lastIndexOf("/"))}/servers` };
  }
  const rootServers = declaredServers(document.servers);
  return rootServers.length > 0 ? { servers: rootServers, prefix: "#/servers" } : null;
}

function declaredServers(raw: unknown): ServerEntry[] {
  return Array.isArray(raw)
    ? raw.filter((value): value is ServerEntry => value !== null && typeof value === "object"
      && !Array.isArray(value) && typeof (value as Record<string, unknown>).url === "string")
    : [];
}

function securityAlternativeCoverage(
  document: OpenAPIDocument,
  operation: OpenAPIOperation,
  parameters: ReturnType<typeof effectiveParameters>,
  selector: string,
  operationKey: string,
  bindingSpec: string,
): SynthesisCoverageEntry[] {
  const requirements = effectiveSecurityRequirements(document, operation);
  if (!requirements || requirements.length === 0) return [];
  const prefix = Array.isArray(operation.security) ? `${selector}/security` : "#/security";
  const entries: SynthesisCoverageEntry[] = [];
  for (const [index] of requirements.entries()) {
    if (securityAlternativeUsable(document, operation, parameters, index)) continue;
    entries.push({
      sourceIndex: 0,
      sourceRef: `${prefix}/${index}`,
      scope: "alternative",
      status: "excluded",
      reasonCode: "openapi.security_alternative_unusable",
      rule: openAPIRule(bindingSpec, "P-04"),
      message: "security alternative is malformed, unresolved, or collides with an owned request destination",
      operationKey,
      bindingSelector: selector,
    });
  }
  return entries;
}

function requestMediaCoverage(
  operation: OpenAPIOperation,
  pathItem: OpenAPIPathItem,
  identity: { operationKey: string; selector: string },
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
  const usable = plans
    .filter((plan) => hasRoutedInputs(bindingSpec) || !candidateCollides(params, plan));
  const represented = new Set(usable.map((plan) => plan.mediaKey));
  return Object.keys(content).sort(codePointCompare).map((mediaType): SynthesisCoverageEntry => {
    const sourceRef = `${identity.selector}/requestBody/content/${escapeJSONPointerToken(mediaType)}`;
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
        bindingSelector: identity.selector,
      };
      const requirements: string[] = [];
      if (usable.some((plan) => plan.mediaKey === mediaType && plan.range)) {
        requirements.push("configuration.requestMedia");
      }
      if (usable.some((plan) =>
        plan.mediaKey === mediaType && requiredPropertyMediaNames(plan).length > 0)) {
        requirements.push("configuration.propertyMedia");
      }
      if (requirements.length > 0) entry.requirements = requirements;
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
      rule: openAPIRule(bindingSpec, collision ? "P-02" : "P-03"),
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
    message: "callbacks and webhooks describe service-to-consumer requests outside the registered OpenAPI family specifications",
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

import type { OBInterface, Operation, BindingEntry, JSONSchema, Source, SynthesizerWarning } from "@openbindings/sdk";
import { MAX_TESTED_VERSION } from "@openbindings/sdk";
import type {
  OpenAPIDocument,
  OpenAPIMediaType,
  OpenAPIOperation,
  OpenAPIParameter,
  OpenAPIPathItem,
} from "./types.js";
import {
  BINDING_SPEC,
  DEFAULT_SOURCE_NAME,
  hasMediaFidelity,
  hasResponseFidelity,
  hasRoutedInputs,
  hasSchemaOmittedOAS30ByteCarriage,
  profileForBindingSpec,
} from "./constants.js";
import {
  DegenerateMediaError,
  FAMILY_JSON,
  FAMILY_MULTIPART,
  candidateCollides,
  binarySignaled,
  isJSONMediaType,
  parseMediaRange,
  parseMediaType,
  planRequestBodies,
  type BodyPlan,
} from "./media.js";
import { effectiveParameters, styleLaneUndefinedExpansionParam, unflattenableParam, validateParameterSerialization } from "./params.js";
import { planAbstractInputRoutes, type AbstractInputRoutes } from "./input-routes-v2.js";
import { translateSchemaDialect } from "./translate.js";
import {
  createOpenAPISchemaProjector,
  type OpenAPISchemaProjector,
} from "./schema-direction.js";
import {
  buildJsonPointerRef,
  codePointCompare,
  componentSchemaNames,
  type DeclaredComponent,
  type LoadedResource,
  type AddressedNode,
  cycleSafeKey,
  decycleSchema,
  escapePointerSegment,
  loadOpenAPIDocument,
  sanitizeKey,
  uniqueKey,
} from "./util.js";
import { isSupportedOpenAPISchemaDialect } from "./ref-siblings.js";
import {
  computeAcceptanceFloor,
  floorInvalidTargetMessage,
  floorOpVerdict,
  type AcceptanceFloor,
} from "@openbindings/openapi-client/analysis";

/**
 * A paths operation admitted by the artifact but unrepresentable under
 * revision 1's flattened boundary. Reported instead of thrown when the
 * caller opts into per-operation tolerance (the coverage and inspection
 * surfaces), so one unrepresentable operation narrows coverage rather than
 * vetoing the document (core §10's posture; interface-synthesizer contract's
 * "sound partial OBI").
 */
export interface UnrealizableTarget {
  /** JSON-pointer ref of the paths operation. */
  ref: string;
  /** The operation key synthesis would have assigned. */
  operationKey: string;
  /** Stable family-namespaced reason code. */
  reasonCode: string;
  /** Governing binding-specification rule. */
  rule: string;
  message: string;
}

/**
 * Loads an OpenAPI document and converts it into an OBInterface with
 * operations and bindings.
 *
 * When `onUnrealizable` is provided, an operation whose candidate boundary
 * boundary cannot be represented is reported and skipped — no operation, no
 * binding — and synthesis continues (tolerant mode: the coverage and
 * inspection surfaces). When absent, the same condition throws (strict mode:
 * `synthesizeInterface`), preserving the convenient strict surface's
 * guarantee that it never returns a statically unbindable partial interface
 * without evidence.
 */
export async function convertToInterface(
  location?: string,
  content?: unknown,
  options?: { signal?: AbortSignal; fetch?: typeof globalThis.fetch },
  onWarning?: (warning: SynthesizerWarning) => void,
  onDocument?: (document: OpenAPIDocument) => void,
  onUnrealizable?: (target: UnrealizableTarget) => void,
  bindingSpec: string = BINDING_SPEC,
  onFloor?: (floor: AcceptanceFloor | undefined) => void,
): Promise<OBInterface> {
  // loadOpenAPIDocument fully dereferences (every $ref, internal and
  // external, matching Go's kin-openapi loader), so extracted schemas are
  // already inlined here.
  // Every document this load composes is recorded, so an externally-declared
  // component can be named by its own document rather than by a counter.
  // Every node the load reaches through a `$ref` is recorded too: those are
  // exactly the nodes that may become cut points, and the artifact's own
  // pointer is what names them.
  const resources: LoadedResource[] = [];
  const addressed: AddressedNode[] = [];
  // The invalid-artifact acceptance floor (openbindings.openapi@1 §3),
  // computed over the entry document's raw image before normalization and
  // dereference. An internal reference identifying no location is tolerated
  // at load: the floor invalidates each unit whose closure reaches it, so a
  // tolerated node is never read by synthesis.
  let floor: AcceptanceFloor | undefined;
  const doc = await loadOpenAPIDocument(
    location,
    content,
    {
      ...options,
      onResource: (root, baseURI) => { resources.push({ root, baseURI }); },
      onRefTarget: (node, declaringRoot, pointer) => {
        addressed.push({ node, declaringRoot, pointer });
      },
      onRawDocument: (raw) => {
        floor = computeAcceptanceFloor(raw);
      },
      tolerateUnresolvableInternalRefs: true,
    },
    options?.fetch,
  );
  // §3 part 2's single derived whole-source refusal fires here, on every
  // synthesis surface.
  if (floor && floor.refusal) throw new Error(floor.refusal);
  onFloor?.(floor);
  // The artifact's own address as the loader used it: a qualified cut-point
  // name is relative to it.
  const artifactBase = resources[0]?.baseURI ?? location;
  onDocument?.(doc);
  // The schema-dialect translation keys off the artifact's own declared
  // version (3.0 vs 3.1); the identifier stays exact and version-free.
  const formatVersion = majorMinor(doc.openapi ?? "3.0");

  const sourceEntry: Source = {
    bindingSpec,
  };
  if (location) sourceEntry.location = location;
  if (content !== undefined) sourceEntry.content = content;

  const iface: OBInterface = {
    openbindings: MAX_TESTED_VERSION,
    operations: {},
    bindings: {},
    sources: { [DEFAULT_SOURCE_NAME]: sourceEntry },
  };

  if (doc.info) {
    if (doc.info.title) iface.name = doc.info.title;
    if (doc.info.version) iface.version = doc.info.version;
    if (doc.info.description) iface.description = doc.info.description;
  }

  if (!doc.paths) {
    delete iface.bindings;
    return iface;
  }

  // Full dereference aliases internal $refs to shared nodes, so a recursive
  // component is a true object cycle here. Schema embedding rewrites cycle
  // participants to self-contained $defs references (decycleSchema).
  const schemaNames = componentSchemaNames(doc, resources, addressed);

  const usedKeys = new Set<string>();

  for (const [pathStr, pathItemRaw] of sortedEntries(doc.paths)) {
    if (pathStr.startsWith("x-") || !pathItemRaw || typeof pathItemRaw !== "object") continue;
    const pathItem = pathItemRaw as OpenAPIPathItem;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== "object") continue;
      const opObj = op as OpenAPIOperation;

      // The acceptance floor (openbindings.openapi@1 §3): a ladder-invalid
      // target is not addressed. Tolerant surfaces skip it (its invalid
      // coverage entry is emitted by the coverage walk); the strict surface
      // throws. Skipped BEFORE key derivation, in every engine identically.
      const floorVerdict = floorOpVerdict(floor, buildJsonPointerRef(pathStr, method));
      if (floorVerdict && floorVerdict.disposition === "invalid") {
        if (onUnrealizable) continue;
        throw new Error(`cannot synthesize OpenAPI operation at ${JSON.stringify(buildJsonPointerRef(pathStr, method))}: ${floorInvalidTargetMessage(floorVerdict.defects.length)}; synthesis would return a statically unbindable partial interface`);
      }

      const opKey = deriveOperationKey(opObj, pathStr, method, usedKeys);
      usedKeys.add(opKey);
      const ref = buildJsonPointerRef(pathStr, method);

      const params = effectiveParameters(pathItem, opObj);
      const unflattenable = unflattenableParam(params, profileForBindingSpec(bindingSpec));
      if (unflattenable) {
        const reason = `parameter ${JSON.stringify(unflattenable)} has no unique flattened identity`;
        if (onUnrealizable) {
          onUnrealizable({
            ref,
            operationKey: opKey,
            reasonCode: "openapi.flattening_collision",
            rule: "OAPI-P-03",
            message: reason,
          });
          continue;
        }
        throw unrealizableOperation(opKey, reason);
      }

      const unsupportedParameter = unsupportedParameterContent(params, bindingSpec);
      if (unsupportedParameter) {
        const reason = `parameter ${JSON.stringify(unsupportedParameter)} declares content with no faithful candidate carriage`;
        if (onUnrealizable) {
          onUnrealizable({
            ref,
            operationKey: opKey,
            reasonCode: "openapi.parameter_content_excluded",
            rule: "OAPI-P-02",
            message: reason,
          });
          continue;
        }
        throw unrealizableOperation(opKey, reason);
      }

      if (hasMediaFidelity(bindingSpec)) {
        let serializationError: unknown;
        for (const parameter of params) {
          try { validateParameterSerialization(parameter); } catch (error: unknown) {
            serializationError = error;
            break;
          }
        }
        if (serializationError !== undefined) {
          const reason = safeErrorMessage(serializationError);
          if (onUnrealizable) {
            onUnrealizable({
              ref,
              operationKey: opKey,
              reasonCode: "openapi.parameter_serialization_excluded",
              rule: "OAPI-P-02",
              message: reason,
            });
            continue;
          }
          throw unrealizableOperation(opKey, reason);
        }
      }

      // A style-lane parameter declaring a member with no defined expansion
      // can never be populated faithfully: every value conforming to the
      // declaration carries that member as a composite, and the governing OAS
      // style row defines no representation for one. The refusal is decided by
      // the DECLARATION, so the operation is excluded here with durable
      // evidence rather than published as represented and refused at
      // invocation. See styleLaneUndefinedExpansionMember in the client's
      // media.ts for the per-edition authority reading.
      const undefinedExpansionMember = styleLaneUndefinedExpansionParam(
        params,
        profileForBindingSpec(bindingSpec),
        formatVersion.startsWith("3.0"),
      );
      if (undefinedExpansionMember !== null) {
        const reason = `parameter member ${JSON.stringify(undefinedExpansionMember)} has no expansion defined by its governing OAS style row`;
        if (onUnrealizable) {
          onUnrealizable({
            ref,
            operationKey: opKey,
            reasonCode: "openapi.parameter_style_expansion_excluded",
            rule: "OAPI-P-02",
            message: reason,
          });
          continue;
        }
        throw unrealizableOperation(opKey, reason);
      }

      let requestPlans: BodyPlan[] = [];
      if (opObj.requestBody) {
        let planError: unknown;
        let plannedCount = 0;
        try {
          const plans = planRequestBodies(opObj, { profile: profileForBindingSpec(bindingSpec), openapiVersion: doc.openapi });
          plannedCount = plans.length;
          requestPlans = plans.filter((plan) => hasRoutedInputs(bindingSpec) || !candidateCollides(params, plan));
        } catch (error: unknown) {
          planError = error;
        }

        if (requestPlans.length === 0 && opObj.requestBody.required) {
          const reason = planError instanceof Error
            ? planError.message
            : planError === undefined
              ? "no artifact-declared request media candidate can realize its required flattened input"
              : safeErrorMessage(planError);
          if (onUnrealizable) {
            // Every plannable candidate colliding with an independently
            // declared parameter is the flattening-identity refusal
            // (OAPI-P-03); a candidate set that never planned is the
            // media-carriage refusal (OAPI-P-04).
            const allCollided = planError === undefined && plannedCount > 0;
            onUnrealizable({
              ref,
              operationKey: opKey,
              reasonCode: allCollided
                ? "openapi.flattening_collision"
                : planError instanceof DegenerateMediaError
                  ? "openapi.media_schema_mismatch"
                  : "openapi.unresolvable_request_body",
              rule: allCollided ? "OAPI-P-03" : "OAPI-P-04",
              message: `${reason}; the required request body has no faithful candidate carriage`,
            });
            continue;
          }
          throw unrealizableOperation(opKey, reason);
        }

        if (requestPlans.length === 0) {
          onWarning?.({
            code: planError instanceof DegenerateMediaError ? "openapi.media_schema_mismatch" : "openapi.unresolvable_request_body",
            message: `${planError instanceof Error ? planError.message : planError === undefined ? "no artifact-declared request media candidate can realize its flattened input" : safeErrorMessage(planError)}; optional body omitted from the synthesized contract`,
            path: `operations.${opKey}.input`,
          });
        }
      }

      const dialectIssue = operationSchemaDialectIssue(doc, params, requestPlans, opObj, bindingSpec);
      if (dialectIssue) {
        const reason = `${dialectIssue.side} schema inherits unsupported dialect ${JSON.stringify(dialectIssue.dialect)} and cannot be projected into OBI's JSON Schema 2020-12 contract`;
        if (onUnrealizable) {
          onUnrealizable({
            ref,
            operationKey: opKey,
            reasonCode: "openapi.unsupported_schema_dialect",
            rule: "OBI-D-06",
            message: reason,
          });
          continue;
        }
        throw unrealizableOperation(opKey, reason);
      }

      const obiOp: Operation = {
        description: opObj.description || opObj.summary || undefined,
        deprecated: opObj.deprecated || undefined,
      };

      if (Array.isArray(opObj.tags) && opObj.tags.length > 0) {
        obiOp.tags = opObj.tags;
      }

      // Embedding rewrites any recursive-component cycle into $defs on the
      // schema root, referenced by same-document pointers from the OBI root
      // (OBI-D-16); translation then runs on an acyclic tree.
      const opPointer = `#/operations/${escapePointerSegment(opKey)}`;
      const routes = planAbstractInputRoutes(params, requestPlans, profileForBindingSpec(bindingSpec));
      const requestProjector = createOpenAPISchemaProjector("request", schemaNames);
      const inputSchema = buildInputSchemaForPlans(
        opObj,
        params,
        requestPlans,
        routes,
        requestProjector,
      );
      if (inputSchema) {
        const acyclicInput = decycleSchema(
          inputSchema,
          requestProjector.componentNames,
          `${opPointer}/input`,
          artifactBase,
        );
        obiOp.input = translateSchemaDialect(acyclicInput, formatVersion) as JSONSchema;
      }

      const responseProjector = createOpenAPISchemaProjector("response", schemaNames);
      const outputSchema = buildOutputSchema(
        opObj,
        responseProjector,
        bindingSpec,
        doc.openapi ?? "3.0",
      );
      if (outputSchema !== undefined) {
        const acyclicOutput = decycleSchema(
          outputSchema,
          responseProjector.componentNames,
          `${opPointer}/output`,
          artifactBase,
        );
        obiOp.output = translateSchemaDialect(acyclicOutput, formatVersion) as JSONSchema;
      }

      iface.operations[opKey] = obiOp;

      const bindingKey = `${opKey}.${DEFAULT_SOURCE_NAME}`;
      const binding: BindingEntry = {
        operation: opKey,
        source: DEFAULT_SOURCE_NAME,
        ref,
      };
      if (hasRoutedInputs(bindingSpec) && routes.needsTransform) {
        binding.inputTransform = routes.transformExpression();
      }
      (iface.bindings as Record<string, BindingEntry>)[bindingKey] = binding;
    }
  }

  if (Object.keys(iface.bindings ?? {}).length === 0) delete iface.bindings;
  return iface;
}

function unrealizableOperation(operationKey: string, reason: string): Error {
  return new Error(
    `cannot synthesize OpenAPI operation ${JSON.stringify(operationKey)}: ${reason}; synthesis would return a statically unbindable partial interface`,
  );
}

function safeErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "unknown request-body planning error";
  }
}

interface OperationSchemaDialectIssue {
  side: "input" | "output";
  dialect: unknown;
}

interface SchemaDialectState {
  portable: boolean;
  dialect: unknown;
}

const PORTABLE_SCHEMA_MAP_KEYS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

const PORTABLE_SCHEMA_ARRAY_KEYS = new Set([
  "oneOf",
  "anyOf",
  "allOf",
  "prefixItems",
]);

const PORTABLE_SCHEMA_SINGLE_KEYS = new Set([
  "items",
  "additionalItems",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
  "contains",
  "contentSchema",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

/**
 * Finds the first artifact Schema Object that cannot be represented under
 * core OBI-D-06. Dialect support is intentionally checked after loading and
 * per operation: a custom OpenAPI document default is valid source syntax and
 * cannot veto a schema-free operation, while a supported per-schema `$schema`
 * override establishes a portable resource even under that custom default.
 */
function operationSchemaDialectIssue(
  doc: OpenAPIDocument,
  params: OpenAPIParameter[],
  requestPlans: BodyPlan[],
  op: OpenAPIOperation,
  bindingSpec: string,
): OperationSchemaDialectIssue | undefined {
  if (majorMinor(doc.openapi ?? "3.0") !== "3.1") return undefined;

  const documentDialect = doc.jsonSchemaDialect;
  const inherited: SchemaDialectState = {
    portable: documentDialect === undefined || isSupportedOpenAPISchemaDialect(documentDialect),
    dialect: documentDialect ?? "https://spec.openapis.org/oas/3.1/dialect/base",
  };

  const inputRoots: unknown[] = [];
  for (const param of params) {
    if (param.schema && typeof param.schema === "object") {
      inputRoots.push(param.schema);
    } else if (param.content && typeof param.content === "object") {
      for (const media of Object.values(param.content as Record<string, OpenAPIMediaType>)) {
        if (media?.schema && typeof media.schema === "object") inputRoots.push(media.schema);
      }
    }
  }
  for (const plan of requestPlans) {
    const schema = plan.media?.schema;
    if (schema && typeof schema === "object") inputRoots.push(schema);
  }
  for (const schema of inputRoots) {
    const dialect = firstUnsupportedSchemaDialect(schema, inherited, new WeakMap());
    if (dialect.found) return { side: "input", dialect: dialect.value };
  }

  for (const schema of projectedSuccessSchemaRoots(op, bindingSpec)) {
    const dialect = firstUnsupportedSchemaDialect(schema, inherited, new WeakMap());
    if (dialect.found) return { side: "output", dialect: dialect.value };
  }
  return undefined;
}

interface UnsupportedDialectResult {
  found: boolean;
  value?: unknown;
}

function firstUnsupportedSchemaDialect(
  node: unknown,
  inherited: SchemaDialectState,
  seen: WeakMap<object, Set<boolean>>,
): UnsupportedDialectResult {
  if (node === null || typeof node !== "object") return { found: false };
  let states = seen.get(node);
  if (!states) {
    states = new Set();
    seen.set(node, states);
  }
  if (states.has(inherited.portable)) return { found: false };
  states.add(inherited.portable);

  if (Array.isArray(node)) {
    for (const item of node) {
      const issue = firstUnsupportedSchemaDialect(item, inherited, seen);
      if (issue.found) return issue;
    }
    return { found: false };
  }

  const schema = node as Record<string, unknown>;
  const local: SchemaDialectState = schema.$schema === undefined
    ? inherited
    : {
      portable: isSupportedOpenAPISchemaDialect(schema.$schema),
      dialect: schema.$schema,
    };
  if (!local.portable) return { found: true, value: local.dialect };

  for (const [key, child] of Object.entries(schema)) {
    if (PORTABLE_SCHEMA_MAP_KEYS.has(key)) {
      if (!child || typeof child !== "object" || Array.isArray(child)) continue;
      for (const nested of Object.values(child as Record<string, unknown>)) {
        const issue = firstUnsupportedSchemaDialect(nested, local, seen);
        if (issue.found) return issue;
      }
    } else if (PORTABLE_SCHEMA_ARRAY_KEYS.has(key)) {
      if (!Array.isArray(child)) continue;
      for (const nested of child) {
        const issue = firstUnsupportedSchemaDialect(nested, local, seen);
        if (issue.found) return issue;
      }
    } else if (PORTABLE_SCHEMA_SINGLE_KEYS.has(key)) {
      const issue = firstUnsupportedSchemaDialect(child, local, seen);
      if (issue.found) return issue;
    }
  }
  return { found: false };
}

/** Returns only source schemas that buildOutputSchema can actually project. */
function projectedSuccessSchemaRoots(op: OpenAPIOperation, bindingSpec: string): unknown[] {
  if (!op.responses) return [];
  const keys = Object.keys(op.responses);
  const hasRange = Object.hasOwn(op.responses, "2XX");
  const exact = keys.filter((key) => /^2[0-9][0-9]$/.test(key));
  const schemas: unknown[] = [];
  for (const key of keys.sort(codePointCompare)) {
    if (!/^2[0-9][0-9]$/.test(key) && key !== "2XX" && !(key === "default" && !hasRange && exact.length < 100)) continue;
    const response = op.responses[key];
    if (!response?.content) continue;
    for (const [mediaKey, media] of Object.entries(response.content)) {
      let admitsJSON: boolean;
      try {
        admitsJSON = isJSONMediaType(parseMediaType(mediaKey, hasMediaFidelity(bindingSpec)).base);
      } catch {
        if (!hasResponseFidelity(bindingSpec)) continue;
        try {
          const range = parseMediaRange(mediaKey, true);
          admitsJSON = range.base === "*/*" || range.base === "application/*";
        } catch { continue; }
      }
      if (!admitsJSON) continue;
      // One unconstrained JSON lane makes the entire synthesized output
      // unconstrained, so no response schema is projected at all.
      if (!Object.hasOwn(media, "schema")) return [];
      if (media.schema && typeof media.schema === "object") schemas.push(media.schema);
    }
  }
  return schemas;
}

/**
 * Iteration order for path-item methods. Exported so `inspectSource`
 * (invoker.ts) walks paths in the exact same order `convertToInterface`
 * does — inspection previews exactly what synthesis would name (Go
 * parity: list_refs.go's `httpMethods` is the same slice `synthesize.go`
 * uses).
 */
export const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/**
 * Derives the operation key SynthesizeInterface would assign. Exported so
 * `inspectSource` (invoker.ts) can suggest the same key synthesis would
 * pick, given the same `used` de-duplication set walked in the same order
 * (Go parity: list_refs.go's InspectSource calls this exact function).
 */
export function deriveOperationKey(
  op: OpenAPIOperation,
  path: string,
  method: string,
  used: Set<string>,
): string {
  if (op.operationId) {
    const key = sanitizeKey(op.operationId);
    if (!used.has(key)) return key;
  }

  const segments = path.replace(/^\/|\/$/g, "").split("/");
  const parts = segments.filter(
    (seg) => seg && !(seg.startsWith("{") && seg.endsWith("}")),
  );

  const key = sanitizeKey(`${parts.join(".")}.${method.toLowerCase()}`);
  return uniqueKey(key, used);
}

function buildInputSchemaForPlans(
  op: OpenAPIOperation,
  allParams: OpenAPIParameter[],
  requestPlans: BodyPlan[],
  routes: AbstractInputRoutes,
  projector: OpenAPISchemaProjector,
): JSONSchema | undefined {
  if (!op.requestBody) return buildInputSchema(op, allParams, undefined, routes, projector);
  const variants = requestPlans
    .map((plan) => buildInputSchema(op, allParams, plan, routes, projector))
    .filter((schema): schema is JSONSchema => schema !== undefined);
  if (!op.requestBody.required) {
    const parameterOnly = buildInputSchema(op, allParams, undefined, routes, projector);
    if (parameterOnly) variants.unshift(parameterOnly);
  }
  // cycleSafeKey: the variants may carry object cycles from recursive
  // components; keys must be total on cyclic graphs. The emitted tree is
  // made acyclic once, at embed time (decycleSchema in convertToInterface).
  const unique = new Map<string, JSONSchema>();
  for (const schema of variants) unique.set(cycleSafeKey(schema), schema);
  const schemas = [...unique.values()];
  if (schemas.length === 0) return undefined;
  if (schemas.length === 1) return schemas[0];
  return { anyOf: schemas };
}

function buildInputSchema(
  op: OpenAPIOperation,
  allParams: OpenAPIParameter[],
  requestPlan?: BodyPlan,
  routes: AbstractInputRoutes = planAbstractInputRoutes(allParams, requestPlan ? [requestPlan] : []),
  projector: OpenAPISchemaProjector = createOpenAPISchemaProjector("request"),
): JSONSchema | undefined {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  // Only JSON-family object candidates can carry undeclared fields by the
  // binding rule. Multipart/form and parameter-only surfaces stay closed.
  const hasOpenBody = requestPlan !== undefined
    && !requestPlan.synthetic
    && !requestPlan.wholeObject
    && (requestPlan.family === FAMILY_JSON || requestPlan.range === true);

  for (const param of allParams) {
    if (!param?.name) continue;
    const prop = paramToSchema(param, projector);
    const field = routes.parameterField(param.in ?? "", param.name);
    if (prop !== undefined) properties[field] = prop;
    if (param.required) required.push(field);
  }

  if (op.requestBody && requestPlan) {
    const rb = op.requestBody;
    let projectedBodySchema: unknown = requestPlan.media && Object.hasOwn(requestPlan.media, "schema")
      ? projector.project(requestPlan.media.schema)
      : undefined;
    if (
      projectedBodySchema
      && typeof projectedBodySchema === "object"
      && !Array.isArray(projectedBodySchema)
      && requestPlan.revision3
      && requestPlan.family === FAMILY_MULTIPART
      && requestPlan.openapiVersion?.startsWith("3.0")
    ) {
      projectedBodySchema = decorateMultipartBinaryBoundaries(
        candidateLocalSchemaClone(
          projectedBodySchema as Record<string, unknown>,
          new Map(),
          projector.componentNames,
        ),
        new Set(),
      );
    }
    // A schema that asserts nothing is the same declaration as an omitted one
    // (§9.2), so the byte lane it selects synthesizes the canonical boundary
    // schema rather than decorating an empty declaration.
    const bodySchema: unknown = requestPlan.rawBoundary
      ? { ...(
          projectedBodySchema && typeof projectedBodySchema === "object" && !Array.isArray(projectedBodySchema)
            && Object.keys(projectedBodySchema).length > 0
            ? projectedBodySchema
            : { type: "string" }
        ), contentEncoding: "base64" }
      : projectedBodySchema ?? (requestPlan.revision3 && requestPlan.synthetic ? {} : undefined);
    if (bodySchema !== undefined) {
      if (typeof bodySchema === "boolean") {
        const field = routes.wholeBodyField || "body";
        properties[field] = bodySchema;
        if (rb.required) required.push(field);
      } else {
      const bodyShape = resolvedSynthesisBodyShape(bodySchema as Record<string, unknown>, new Set());
      const bodyProps = bodyShape.properties;
      if (!bodyShape.object || requestPlan.wholeObject) {
        // A non-object body, an explicitly dynamic object, or a
        // declaration-complex JSON body rides as one protocol-independent
        // application value.
        // Non-object schemas include array, scalar, binary, and TYPELESS
        // (neither `properties` nor an explicit object type; §9.1's
        // determination is declaration-only): the flattened contract
        // carries it under the synthetic `body` property, unwrapped at
        // the wire.
        const field = routes.wholeBodyField || "body";
        properties[field] = bodySchema;
        if (rb.required) required.push(field);
      } else if (Object.keys(bodyProps).length > 0) {
        for (const [k, v] of Object.entries(bodyProps)) {
          // Colliding candidates were removed before this plan was chosen.
          properties[routes.bodyField(k)] = v;
        }
        required.push(...[...bodyShape.required].map((name) => routes.bodyField(name)));
      } else {
        // A free-form object body (type object, no named properties): the
        // flattened model passes unmatched input fields through into the
        // body (openbindings.openapi@1 §9.1), so the flattened surface
        // stays an OPEN object — the synthetic `body` wrap is reserved for
        // NON-object body schemas, and wrapping here would describe a
        // field the conformant invoker refuses as unmatched.
        // hasOpenBody was determined by the selected candidate's family.
      }
      }
    }
  }

  if (Object.keys(properties).length === 0) {
    if (hasOpenBody) return { type: "object" };
    if (requestPlan && op.requestBody?.required) return { type: "object", additionalProperties: false };
    return undefined;
  }

  const schema: JSONSchema = {
    type: "object",
    properties,
    ...(hasOpenBody ? {} : { additionalProperties: false }),
  };
  if (required.length > 0) {
    schema.required = [...required].sort(codePointCompare);
  }
  return schema;
}

function decorateMultipartBinaryBoundaries(
  schema: Record<string, unknown>,
  seen: Set<Record<string, unknown>>,
): Record<string, unknown> {
  if (seen.has(schema)) return schema;
  seen.add(schema);
  // The multipart runtime decodes only direct property parts and repeated
  // array item parts. Nested properties inside an object part are JSON
  // members, not independent binary parts, so recursively decorating them
  // would overclaim a decode the wire builder never performs.
  const properties = schema.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const property of Object.values(properties as Record<string, unknown>)) {
      if (property && typeof property === "object" && !Array.isArray(property)) {
        decorateMultipartPartBoundary(property as Record<string, unknown>);
      }
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const member of schema.allOf) {
      if (member && typeof member === "object" && !Array.isArray(member)) {
        decorateMultipartBinaryBoundaries(member as Record<string, unknown>, seen);
      }
    }
  }
  return schema;
}

function decorateMultipartPartBoundary(schema: Record<string, unknown>): void {
  if (synthesisSchemaTypeIs(schema, "string") && synthesisSchemaFormatIs(schema, "binary")) {
    schema.contentEncoding = "base64";
    return;
  }
  if (!synthesisSchemaTypeIs(schema, "array")) return;
  decorateMultipartItemBoundary(schema.items);
  if (Array.isArray(schema.allOf)) {
    for (const member of schema.allOf) {
      if (member && typeof member === "object" && !Array.isArray(member)) {
        decorateMultipartItemBoundary((member as Record<string, unknown>).items);
      }
    }
  }
}

function decorateMultipartItemBoundary(items: unknown): void {
  if (
    items
    && typeof items === "object"
    && !Array.isArray(items)
    && synthesisSchemaTypeIs(items as Record<string, unknown>, "string")
    && synthesisSchemaFormatIs(items as Record<string, unknown>, "binary")
  ) {
    (items as Record<string, unknown>).contentEncoding = "base64";
  }
}

function candidateLocalSchemaClone<T>(
  value: T,
  memo: Map<object, unknown>,
  componentNames: ReadonlyMap<object, DeclaredComponent>,
): T {
  if (value === null || typeof value !== "object") return value;
  const cached = memo.get(value);
  if (cached !== undefined) return cached as T;
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    memo.set(value, clone);
    for (const member of value) {
      clone.push(candidateLocalSchemaClone(member, memo, componentNames));
    }
    return clone as T;
  }
  const clone: Record<string, unknown> = {};
  memo.set(value, clone);
  const componentName = componentNames.get(value);
  if (componentName !== undefined) {
    (componentNames as Map<object, DeclaredComponent>).set(clone, componentName);
  }
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    clone[key] = candidateLocalSchemaClone(member, memo, componentNames);
  }
  return clone as T;
}

function synthesisSchemaTypeIs(schema: Record<string, unknown>, want: string): boolean {
  if (schema.type === want) return true;
  if (Array.isArray(schema.type) && schema.type.includes(want)) return true;
  return Array.isArray(schema.allOf) && schema.allOf.some((member) =>
    member !== null
    && typeof member === "object"
    && !Array.isArray(member)
    && synthesisSchemaTypeIs(member as Record<string, unknown>, want));
}

function synthesisSchemaFormatIs(schema: Record<string, unknown>, want: string): boolean {
  if (schema.format === want) return true;
  return Array.isArray(schema.allOf) && schema.allOf.some((member) =>
    member !== null
    && typeof member === "object"
    && !Array.isArray(member)
    && synthesisSchemaFormatIs(member as Record<string, unknown>, want));
}

interface SynthesisBodyShape {
  object: boolean;
  properties: Record<string, unknown>;
  required: Set<string>;
}

/**
 * Resolves the declaration-only object surface used by OAPI-P-03 synthesis.
 * `allOf` contributes its recursive property and required-name union; wrapping
 * the `allOf` node as a synthetic whole body would publish a contract that the
 * invoker (correctly) routes as object properties.
 */
function resolvedSynthesisBodyShape(
  schema: Record<string, unknown>,
  seen: Set<Record<string, unknown>>,
): SynthesisBodyShape {
  if (seen.has(schema)) return { object: false, properties: {}, required: new Set() };
  seen.add(schema);
  try {
    const properties: Record<string, unknown> = {};
    const ownProperties = schema.properties;
    const declaresProperties = ownProperties !== undefined && ownProperties !== null &&
      typeof ownProperties === "object" && !Array.isArray(ownProperties);
    if (declaresProperties) {
      Object.assign(properties, ownProperties as Record<string, unknown>);
    }
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((name): name is string => typeof name === "string")
        : [],
    );
    const type = schema.type;
    let object = declaresProperties || type === "object" ||
      (Array.isArray(type) && type.length === 1 && type[0] === "object");
    if (Array.isArray(schema.allOf)) {
      for (const member of schema.allOf) {
        if (!member || typeof member !== "object" || Array.isArray(member)) continue;
        const nested = resolvedSynthesisBodyShape(member as Record<string, unknown>, seen);
        object ||= nested.object;
        for (const [name, property] of Object.entries(nested.properties)) {
          properties[name] = properties[name] === undefined
            ? property
            : { allOf: [properties[name], property] };
        }
        for (const name of nested.required) required.add(name);
      }
    }
    return { object, properties, required };
  } finally {
    seen.delete(schema);
  }
}

function paramToSchema(
  param: OpenAPIParameter,
  projector: OpenAPISchemaProjector,
): JSONSchema | undefined {
  let schema: JSONSchema;
  if (Object.hasOwn(param, "schema")) {
    schema = projector.project(param.schema) as JSONSchema;
  } else if (param.content && typeof param.content === "object") {
    const media = Object.values(param.content as Record<string, OpenAPIMediaType>)[0];
    schema = media && Object.hasOwn(media, "schema")
      ? projector.project(media.schema) as JSONSchema
      : { type: "string" };
  } else {
    schema = { type: "string" };
  }
  if (param.description) {
    schema = typeof schema === "boolean"
      ? { allOf: [schema], description: param.description }
      : { ...schema, description: param.description };
  }
  return schema;
}

/**
 * Returns the first content-form parameter whose single media declaration
 * cannot be serialized by the candidate. Synthesis must not publish an operation
 * that the binding is statically guaranteed to refuse when that parameter is
 * used; tolerant synthesis excludes the complete target with durable evidence.
 */
function unsupportedParameterContent(
  params: OpenAPIParameter[],
  bindingSpec: string,
): string | undefined {
  for (const param of params) {
    if (!param?.name || !param.content || typeof param.content !== "object") continue;
    const keys = Object.keys(param.content);
    if (keys.length !== 1) return param.name;
    try {
      const media = parseMediaType(keys[0]!, hasMediaFidelity(bindingSpec));
      if (!isJSONMediaType(media.base) && media.base !== "text/plain") return param.name;
      if (
        hasMediaFidelity(bindingSpec)
        && media.params["charset"] !== undefined
        && !["utf-8", "us-ascii", "iso-8859-1"].includes(media.params["charset"].toLowerCase())
      ) return param.name;
    } catch {
      return param.name;
    }
  }
  return undefined;
}

function buildOutputSchema(
  op: OpenAPIOperation,
  projector: OpenAPISchemaProjector,
  bindingSpec: string,
  openapiVersion: string,
): JSONSchema | undefined {
  if (!op.responses) return undefined;
  const keys = Object.keys(op.responses);
  const hasRange = Object.hasOwn(op.responses, "2XX");
  const exact = keys.filter((key) => /^2[0-9][0-9]$/.test(key));
  const schemas: JSONSchema[] = [];
  for (const key of keys.sort(codePointCompare)) {
    if (!/^2[0-9][0-9]$/.test(key) && key !== "2XX" && !(key === "default" && !hasRange && exact.length < 100)) continue;
    const response = op.responses[key];
    if (!response?.content) continue; // this outcome emits no value
    for (const [mediaKey, media] of Object.entries(response.content).sort(([a], [b]) => codePointCompare(a, b))) {
      let base: string;
      let range = false;
      try {
        base = parseMediaType(mediaKey, hasMediaFidelity(bindingSpec)).base;
      } catch {
        if (!hasResponseFidelity(bindingSpec)) continue;
        try {
          base = parseMediaRange(mediaKey, true).base;
          range = true;
        } catch { continue; }
      }
      const admitsJSON = isJSONMediaType(base)
        || (range && (base === "application/*" || base === "*/*"));
      if (admitsJSON) {
        // A JSON success declaration without a schema can emit any JSON
        // value; the synthesized OBI must not make a narrower claim.
        if (!Object.hasOwn(media, "schema")) return undefined;
        schemas.push(projector.project(media.schema) as JSONSchema);
      }

      const admitsNonJSON = !isJSONMediaType(base) || range;
      if (admitsNonJSON) {
        const rawBoundary = hasResponseFidelity(bindingSpec)
          && !base.startsWith("text/")
          && (
            (openapiVersion.startsWith("3.0")
              && ((hasSchemaOmittedOAS30ByteCarriage(bindingSpec) && !range && !Object.hasOwn(media, "schema"))
                || (media.schema !== null
                  && typeof media.schema === "object"
                  && binarySignaled(media.schema, true))))
            || (!openapiVersion.startsWith("3.0") && !Object.hasOwn(media, "schema"))
          );
        // Revision 1's builtin non-JSON response lane is text, including
        // one string per SSE event. The artifact-authorized byte
        // lane uses a protocol-independent canonical Base64 boundary.
        schemas.push(rawBoundary
          ? { type: "string", contentEncoding: "base64" }
          : { type: "string" });
      }
    }
  }
  const unique = [...new Map(schemas.map((schema) => [cycleSafeKey(schema), schema])).values()];
  if (unique.length === 0) return undefined;
  return unique.length === 1 ? unique[0] : { anyOf: unique };
}

function sortedEntries(obj: Record<string, unknown>): [string, unknown][] {
  return Object.entries(obj).sort(([a], [b]) => codePointCompare(a, b));
}

/**
 * Reduces an artifact version string to its major.minor form
 * ("3.1.0" → "3.1") for dialect decisions. Mirrors the Go SDK's majorMinor
 * (formats/openapi/synthesize.go).
 */
function majorMinor(version: string): string {
  const parts = version.split(".");
  if (parts.length >= 2) return `${parts[0]}.${parts[1]}`;
  return version;
}

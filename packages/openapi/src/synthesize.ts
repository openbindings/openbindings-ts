import type { OBInterface, Operation, BindingEntry, JSONSchema, Source, SynthesizerWarning } from "@openbindings/sdk";
import { MAX_TESTED_VERSION } from "@openbindings/sdk";
import type {
  OpenAPIDocument,
  OpenAPIMediaType,
  OpenAPIOperation,
  OpenAPIParameter,
  OpenAPIPathItem,
} from "./types.js";
import { BINDING_SPEC, BINDING_SPEC_V2, DEFAULT_SOURCE_NAME } from "./constants.js";
import {
  DegenerateMediaError,
  FAMILY_JSON,
  candidateCollides,
  isJSONMediaType,
  parseMediaType,
  planRequestBodies,
  type BodyPlan,
} from "./media.js";
import { effectiveParameters, unflattenableParam } from "./params.js";
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
  cycleSafeKey,
  decycleSchema,
  escapePointerSegment,
  loadOpenAPIDocument,
  sanitizeKey,
  uniqueKey,
} from "./util.js";
import { isSupportedOpenAPISchemaDialect } from "./ref-siblings.js";

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
 * When `onUnrealizable` is provided, an operation whose revision-1 flattened
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
): Promise<OBInterface> {
  // loadOpenAPIDocument fully dereferences (every $ref, internal and
  // external, matching Go's kin-openapi loader), so extracted schemas are
  // already inlined here.
  const doc = await loadOpenAPIDocument(
    location,
    content,
    options,
    options?.fetch,
  );
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

  if (!doc.paths) return iface;

  // Full dereference aliases internal $refs to shared nodes, so a recursive
  // component is a true object cycle here. Schema embedding rewrites cycle
  // participants to self-contained $defs references (decycleSchema).
  const schemaNames = componentSchemaNames(doc);

  const usedKeys = new Set<string>();

  for (const [pathStr, pathItemRaw] of sortedEntries(doc.paths)) {
    if (pathStr.startsWith("x-") || !pathItemRaw || typeof pathItemRaw !== "object") continue;
    const pathItem = pathItemRaw as OpenAPIPathItem;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== "object") continue;
      const opObj = op as OpenAPIOperation;

      const opKey = deriveOperationKey(opObj, pathStr, method, usedKeys);
      usedKeys.add(opKey);
      const ref = buildJsonPointerRef(pathStr, method);

      const params = effectiveParameters(pathItem, opObj);
      const unflattenable = unflattenableParam(params, bindingSpec);
      if (unflattenable) {
        const reason = `parameter ${JSON.stringify(unflattenable)} has no unique revision-1 flattened identity`;
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

      const unsupportedParameter = unsupportedParameterContent(params);
      if (unsupportedParameter) {
        const reason = `parameter ${JSON.stringify(unsupportedParameter)} declares content with no faithful revision-2 carriage`;
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

      let requestPlans: BodyPlan[] = [];
      if (opObj.requestBody) {
        let planError: unknown;
        let plannedCount = 0;
        try {
          const plans = planRequestBodies(opObj);
          plannedCount = plans.length;
          requestPlans = plans.filter((plan) => bindingSpec === BINDING_SPEC_V2 || !candidateCollides(params, plan));
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
              message: `${reason}; the required request body has no faithful revision-1 carriage`,
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

      const dialectIssue = operationSchemaDialectIssue(doc, params, requestPlans, opObj);
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
      const routes = planAbstractInputRoutes(params, requestPlans);
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
        );
        obiOp.input = translateSchemaDialect(acyclicInput, formatVersion) as JSONSchema;
      }

      const responseProjector = createOpenAPISchemaProjector("response", schemaNames);
      const outputSchema = buildOutputSchema(opObj, responseProjector);
      if (outputSchema) {
        const acyclicOutput = decycleSchema(
          outputSchema,
          responseProjector.componentNames,
          `${opPointer}/output`,
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
      if (bindingSpec === BINDING_SPEC_V2 && routes.needsTransform) {
        binding.inputTransform = routes.transformExpression();
      }
      (iface.bindings as Record<string, BindingEntry>)[bindingKey] = binding;
    }
  }

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

  for (const schema of projectedSuccessSchemaRoots(op)) {
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
function projectedSuccessSchemaRoots(op: OpenAPIOperation): unknown[] {
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
      let parsed;
      try { parsed = parseMediaType(mediaKey); } catch { continue; }
      if (!isJSONMediaType(parsed.base)) continue;
      // One unconstrained JSON lane makes the entire synthesized output
      // unconstrained, so no response schema is projected at all.
      if (!media.schema) return [];
      schemas.push(media.schema);
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
  const hasOpenBody = requestPlan?.family === FAMILY_JSON && !requestPlan.synthetic;

  for (const param of allParams) {
    if (!param?.name) continue;
    const prop = paramToSchema(param, projector);
    const field = routes.parameterField(param.in ?? "", param.name);
    if (prop) properties[field] = prop;
    if (param.required) required.push(field);
  }

  if (op.requestBody && requestPlan) {
    const rb = op.requestBody;
    const bodySchema = requestPlan.media?.schema
      ? projector.project(requestPlan.media.schema) as Record<string, unknown>
      : undefined;
    if (bodySchema) {
      const bodyShape = resolvedSynthesisBodyShape(bodySchema, new Set());
      const bodyProps = bodyShape.properties;
      if (!bodyShape.object) {
        // A non-object body schema — array, scalar, binary, or TYPELESS
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
): Record<string, unknown> | undefined {
  let schema: Record<string, unknown>;
  if (param.schema && typeof param.schema === "object") {
    schema = { ...(projector.project(param.schema) as Record<string, unknown>) };
  } else if (param.content && typeof param.content === "object") {
    const media = Object.values(param.content as Record<string, OpenAPIMediaType>)[0];
    schema = media?.schema && typeof media.schema === "object"
      ? { ...(projector.project(media.schema) as Record<string, unknown>) }
      : { type: "string" };
  } else {
    schema = { type: "string" };
  }
  if (param.description) schema.description = param.description;
  return schema;
}

/**
 * Returns the first content-form parameter whose single media declaration
 * cannot be serialized by revision 2. Synthesis must not publish an operation
 * that the binding is statically guaranteed to refuse when that parameter is
 * used; tolerant synthesis excludes the complete target with durable evidence.
 */
function unsupportedParameterContent(params: OpenAPIParameter[]): string | undefined {
  for (const param of params) {
    if (!param?.name || !param.content || typeof param.content !== "object") continue;
    const keys = Object.keys(param.content);
    if (keys.length !== 1) return param.name;
    try {
      const media = parseMediaType(keys[0]!);
      if (!isJSONMediaType(media.base) && media.base !== "text/plain") return param.name;
    } catch {
      return param.name;
    }
  }
  return undefined;
}

function buildOutputSchema(
  op: OpenAPIOperation,
  projector: OpenAPISchemaProjector,
): JSONSchema | undefined {
  if (!op.responses) return undefined;
  const keys = Object.keys(op.responses);
  const hasRange = Object.hasOwn(op.responses, "2XX");
  const exact = keys.filter((key) => /^2[0-9][0-9]$/.test(key));
  const schemas: Record<string, unknown>[] = [];
  for (const key of keys.sort(codePointCompare)) {
    if (!/^2[0-9][0-9]$/.test(key) && key !== "2XX" && !(key === "default" && !hasRange && exact.length < 100)) continue;
    const response = op.responses[key];
    if (!response?.content) continue; // this outcome emits no value
    for (const [mediaKey, media] of Object.entries(response.content).sort(([a], [b]) => codePointCompare(a, b))) {
      let parsed;
      try { parsed = parseMediaType(mediaKey); } catch { continue; }
      if (isJSONMediaType(parsed.base)) {
        // A JSON success declaration without a schema can emit any JSON
        // value; the synthesized OBI must not make a narrower claim.
        if (!media.schema) return undefined;
        schemas.push(projector.project(media.schema) as Record<string, unknown>);
      } else {
        // Revision 1's builtin non-JSON response lane is text, including
        // one string per SSE event, irrespective of an OAS schema claim.
        schemas.push({ type: "string" });
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

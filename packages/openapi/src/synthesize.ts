import type { OBInterface, Operation, BindingEntry, JSONSchema, Source, SynthesizerWarning } from "@openbindings/sdk";
import { MAX_TESTED_VERSION } from "@openbindings/sdk";
import type {
  OpenAPIDocument,
  OpenAPIMediaType,
  OpenAPIOperation,
  OpenAPIParameter,
  OpenAPIPathItem,
} from "./types.js";
import { BINDING_SPEC, DEFAULT_SOURCE_NAME } from "./constants.js";
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
import { translateSchemaDialect } from "./translate.js";
import {
  bodySchemaFlattens,
  buildJsonPointerRef,
  codePointCompare,
  loadOpenAPIDocument,
  sanitizeKey,
  uniqueKey,
} from "./util.js";

/** Loads an OpenAPI document and converts it into an OBInterface with operations and bindings. */
export async function convertToInterface(
  location?: string,
  content?: unknown,
  options?: { signal?: AbortSignal },
  onWarning?: (warning: SynthesizerWarning) => void,
  onDocument?: (document: OpenAPIDocument) => void,
): Promise<OBInterface> {
  // loadOpenAPIDocument fully dereferences (every $ref, internal and
  // external, matching Go's kin-openapi loader), so extracted schemas are
  // already inlined here.
  const doc = await loadOpenAPIDocument(location, content, options);
  onDocument?.(doc);
  // The schema-dialect translation keys off the artifact's own declared
  // version (3.0 vs 3.1); the identifier stays exact and version-free.
  const formatVersion = majorMinor(doc.openapi ?? "3.0");

  const sourceEntry: Source = {
    bindingSpec: BINDING_SPEC,
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

      const params = effectiveParameters(pathItem, opObj);
      const unflattenable = unflattenableParam(params);
      if (unflattenable) {
        throw unrealizableOperation(
          opKey,
          `parameter ${JSON.stringify(unflattenable)} has no unique revision-1 flattened identity`,
        );
      }

      let requestPlans: BodyPlan[] = [];
      if (opObj.requestBody) {
        let planError: unknown;
        try {
          const plans = planRequestBodies(opObj);
          requestPlans = plans.filter((plan) => !candidateCollides(params, plan));
        } catch (error: unknown) {
          planError = error;
        }

        if (requestPlans.length === 0 && opObj.requestBody.required) {
          const reason = planError instanceof Error
            ? planError.message
            : planError === undefined
              ? "no artifact-declared request media candidate can realize its required flattened input"
              : safeErrorMessage(planError);
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

      const obiOp: Operation = {
        description: opObj.description || opObj.summary || undefined,
        deprecated: opObj.deprecated || undefined,
      };

      if (Array.isArray(opObj.tags) && opObj.tags.length > 0) {
        obiOp.tags = opObj.tags;
      }

      const inputSchema = buildInputSchemaForPlans(opObj, params, requestPlans);
      if (inputSchema) {
        obiOp.input = translateSchemaDialect(inputSchema, formatVersion) as JSONSchema;
      }

      const outputSchema = buildOutputSchema(opObj);
      if (outputSchema) {
        obiOp.output = translateSchemaDialect(outputSchema, formatVersion) as JSONSchema;
      }

      iface.operations[opKey] = obiOp;

      const ref = buildJsonPointerRef(pathStr, method);
      const bindingKey = `${opKey}.${DEFAULT_SOURCE_NAME}`;
      (iface.bindings as Record<string, BindingEntry>)[bindingKey] = {
        operation: opKey,
        source: DEFAULT_SOURCE_NAME,
        ref,
      };
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
): JSONSchema | undefined {
  if (!op.requestBody) return buildInputSchema(op, allParams);
  const variants = requestPlans
    .map((plan) => buildInputSchema(op, allParams, plan))
    .filter((schema): schema is JSONSchema => schema !== undefined);
  if (!op.requestBody.required) {
    const parameterOnly = buildInputSchema(op, allParams);
    if (parameterOnly) variants.unshift(parameterOnly);
  }
  const unique = new Map<string, JSONSchema>();
  for (const schema of variants) unique.set(JSON.stringify(schema), schema);
  const schemas = [...unique.values()];
  if (schemas.length === 0) return undefined;
  if (schemas.length === 1) return schemas[0];
  return { anyOf: schemas };
}

function buildInputSchema(
  op: OpenAPIOperation,
  allParams: OpenAPIParameter[],
  requestPlan?: BodyPlan,
): JSONSchema | undefined {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  // Only JSON-family object candidates can carry undeclared fields by the
  // binding rule. Multipart/form and parameter-only surfaces stay closed.
  const hasOpenBody = requestPlan?.family === FAMILY_JSON && !requestPlan.synthetic;

  for (const param of allParams) {
    if (!param?.name) continue;
    const prop = paramToSchema(param);
    if (prop) properties[param.name] = prop;
    if (param.required) required.push(param.name);
  }

  if (op.requestBody && requestPlan) {
    const rb = op.requestBody;
    const bodySchema = requestPlan.media?.schema ? { ...requestPlan.media.schema } : undefined;
    if (bodySchema) {
      const bodyProps = bodySchema.properties as Record<string, unknown> | undefined;
      if (!bodySchemaFlattens(bodySchema)) {
        // A non-object body schema — array, scalar, binary, or TYPELESS
        // (neither `properties` nor an explicit object type; §9.1's
        // determination is declaration-only): the flattened contract
        // carries it under the synthetic `body` property, unwrapped at
        // the wire.
        properties["body"] = bodySchema;
        if (rb.required) required.push("body");
      } else if (bodyProps && typeof bodyProps === "object") {
        for (const [k, v] of Object.entries(bodyProps)) {
          // Colliding candidates were removed before this plan was chosen.
          properties[k] = v;
        }
        if (Array.isArray(bodySchema.required)) {
          // OAS contract: `required` members are strings. A malformed member
          // passes through unchanged (same as before typing) and surfaces in
          // downstream OBI validation rather than being silently dropped.
          required.push(...(bodySchema.required as string[]));
        }
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

function paramToSchema(param: OpenAPIParameter): Record<string, unknown> | undefined {
  let schema: Record<string, unknown>;
  if (param.schema && typeof param.schema === "object") {
    schema = { ...param.schema };
  } else if (param.content && typeof param.content === "object") {
    const media = Object.values(param.content as Record<string, OpenAPIMediaType>)[0];
    schema = media?.schema && typeof media.schema === "object" ? { ...media.schema } : { type: "string" };
  } else {
    schema = { type: "string" };
  }
  if (param.description) schema.description = param.description;
  return schema;
}

function buildOutputSchema(op: OpenAPIOperation): JSONSchema | undefined {
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
        schemas.push({ ...media.schema });
      } else {
        // Revision 1's builtin non-JSON response lane is text, including
        // one string per SSE event, irrespective of an OAS schema claim.
        schemas.push({ type: "string" });
      }
    }
  }
  const unique = [...new Map(schemas.map((schema) => [JSON.stringify(schema), schema])).values()];
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

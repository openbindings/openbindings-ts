import type { OBInterface, Operation, BindingEntry, JSONSchema, Source, SynthesizerWarning } from "@openbindings/sdk";
import { MAX_TESTED_VERSION, detectFormatVersion } from "@openbindings/sdk";
import type {
  OpenAPIDocument,
  OpenAPIMediaType,
  OpenAPIOperation,
  OpenAPIParameter,
  OpenAPIRequestBody,
  OpenAPIResponse,
} from "./types.js";
import { DEFAULT_SOURCE_NAME } from "./constants.js";
import { translateSchemaDialect } from "./translate.js";
import {
  buildJsonPointerRef,
  loadOpenAPIDocument,
  mergeParameters,
  sanitizeKey,
  uniqueKey,
} from "./util.js";

/** Loads an OpenAPI document and converts it into an OBInterface with operations and bindings. */
export async function convertToInterface(
  location?: string,
  content?: unknown,
  options?: { signal?: AbortSignal },
  onWarning?: (warning: SynthesizerWarning) => void,
): Promise<OBInterface> {
  // loadOpenAPIDocument fully dereferences (every $ref, internal and
  // external, matching Go's kin-openapi loader), so extracted schemas are
  // already inlined here.
  const doc = await loadOpenAPIDocument(location, content, options);
  const formatVersion = detectFormatVersion(doc.openapi ?? "3.0");

  const sourceEntry: Source = {
    format: `openapi@${formatVersion}`,
  };
  if (location) sourceEntry.location = location;

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
    const pathItem = pathItemRaw as Record<string, unknown>;
    const pathParams = (pathItem.parameters ?? []) as OpenAPIParameter[];

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== "object") continue;
      const opObj = op as OpenAPIOperation;

      const opKey = deriveOperationKey(opObj, pathStr, method, usedKeys);
      usedKeys.add(opKey);

      const obiOp: Operation = {
        description: opObj.description || opObj.summary || undefined,
        deprecated: opObj.deprecated || undefined,
      };

      if (Array.isArray(opObj.tags) && opObj.tags.length > 0) {
        obiOp.tags = opObj.tags;
      }

      const inputSchema = buildInputSchema(opObj, pathParams, opKey, onWarning);
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

function buildInputSchema(
  op: OpenAPIOperation,
  pathParams: OpenAPIParameter[],
  opKey: string,
  onWarning?: (warning: SynthesizerWarning) => void,
): JSONSchema | undefined {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  const allParams = mergeParameters(pathParams, op.parameters ?? []);

  for (const param of allParams) {
    if (!param?.name || param.in === "cookie") continue;
    const prop = paramToSchema(param);
    if (prop) properties[param.name] = prop;
    if (param.required) required.push(param.name);
  }

  if (op.requestBody) {
    const rb = op.requestBody;
    const bodySchema = requestBodyToSchema(rb);
    if (bodySchema) {
      const bodyProps = bodySchema.properties as Record<string, unknown> | undefined;
      if (bodyProps && typeof bodyProps === "object") {
        for (const [k, v] of Object.entries(bodyProps)) {
          // Field-collision rule: a name declared as a parameter AND a
          // body property flattens to ONE input field (the body's schema
          // wins deterministically); at invocation the one value is
          // delivered to every declared wire location. Warn so the merge
          // is never silent.
          if (k in properties) {
            onWarning?.({
              code: "openapi.param_body_collision",
              message: `field "${k}" is declared as a parameter and a body property; the flattened input carries one field (body schema shown) whose value is delivered to both wire locations at invocation`,
              path: `operations.${opKey}.input.properties.${k}`,
            });
          }
          properties[k] = v;
        }
        if (Array.isArray(bodySchema.required)) {
          required.push(...bodySchema.required);
        }
      } else {
        properties["body"] = bodySchema;
        if (rb.required) required.push("body");
      }
    }
  }

  if (Object.keys(properties).length === 0) return undefined;

  const schema: JSONSchema = { type: "object", properties };
  if (required.length > 0) {
    schema.required = [...required].sort();
  }
  return schema;
}

function paramToSchema(param: OpenAPIParameter): Record<string, unknown> | undefined {
  let schema: Record<string, unknown>;
  if (param.schema && typeof param.schema === "object") {
    schema = { ...param.schema };
  } else {
    schema = { type: "string" };
  }
  if (param.description) schema.description = param.description;
  return schema;
}

function requestBodyToSchema(rb: OpenAPIRequestBody): Record<string, unknown> | undefined {
  if (!rb.content) return undefined;
  const mt = preferJsonMediaType(rb.content);
  if (!mt?.schema) return undefined;
  return { ...mt.schema };
}

function buildOutputSchema(op: OpenAPIOperation): JSONSchema | undefined {
  if (!op.responses) return undefined;
  for (const code of ["200", "201", "202"]) {
    const resp = op.responses[code];
    if (!resp) continue;
    return responseToSchema(resp);
  }
  return undefined;
}

function responseToSchema(resp: OpenAPIResponse): Record<string, unknown> | undefined {
  if (!resp.content) return undefined;
  const mt = preferJsonMediaType(resp.content);
  if (!mt?.schema) return undefined;
  return { ...mt.schema };
}

function preferJsonMediaType(content: Record<string, OpenAPIMediaType>): OpenAPIMediaType | undefined {
  if (content["application/json"]) return content["application/json"];
  const keys = Object.keys(content).sort();
  for (const k of keys) {
    if (k.includes("json")) return content[k];
  }
  return keys.length > 0 ? content[keys[0]] : undefined;
}

function sortedEntries(obj: Record<string, unknown>): [string, unknown][] {
  return Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));
}

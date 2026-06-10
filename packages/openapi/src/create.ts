import type { OBInterface, Operation, BindingEntry, JSONSchema, Source } from "@openbindings/sdk";
import { MAX_TESTED_VERSION, detectFormatVersion, dereference } from "@openbindings/sdk";
import yaml from "js-yaml";
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
): Promise<OBInterface> {
  const rawDoc = await loadOpenAPIDocument(location, content, options);
  // Resolve all $ref pointers so extracted schemas are fully inlined,
  // matching Go's kin-openapi behavior.
  const doc = await dereference(rawDoc as Record<string, unknown>, {
    baseUrl: location,
    parse: (text) => yaml.load(text) as Record<string, unknown>,
    signal: options?.signal,
  }) as unknown as OpenAPIDocument;
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

      const inputSchema = buildInputSchema(opObj, pathParams);
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

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

function deriveOperationKey(
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

function buildInputSchema(op: OpenAPIOperation, pathParams: OpenAPIParameter[]): JSONSchema | undefined {
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
        Object.assign(properties, bodyProps);
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

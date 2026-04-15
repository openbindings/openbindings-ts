import type { OBInterface, Operation, BindingEntry, JSONSchema, Source, SecurityMethod } from "@openbindings/sdk";
import { MAX_TESTED_VERSION, detectFormatVersion, dereference } from "@openbindings/sdk";
import yaml from "js-yaml";
import type {
  OpenAPIDocument,
  OpenAPIMediaType,
  OpenAPIOperation,
  OpenAPIParameter,
  OpenAPIRequestBody,
  OpenAPIResponse,
  OpenAPISecurityScheme,
  OpenAPIOAuthFlow,
} from "./types.js";
import { DEFAULT_SOURCE_NAME } from "./constants.js";
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
      if (inputSchema) obiOp.input = inputSchema;

      const outputSchema = buildOutputSchema(opObj);
      if (outputSchema) obiOp.output = outputSchema;

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

  populateSecurity(doc, iface);

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

/**
 * Reads security schemes from the OpenAPI doc and populates iface.security
 * and each binding's security field.
 */
function populateSecurity(doc: OpenAPIDocument, iface: OBInterface): void {
  const components = doc.components as Record<string, unknown> | undefined;
  if (!components) return;
  const securitySchemes = components.securitySchemes as Record<string, OpenAPISecurityScheme> | undefined;
  if (!securitySchemes || Object.keys(securitySchemes).length === 0) return;

  // Convert all security schemes to SecurityMethod.
  const schemeMethods: Record<string, SecurityMethod> = {};
  for (const [name, scheme] of Object.entries(securitySchemes)) {
    if (!scheme || typeof scheme !== "object") continue;
    schemeMethods[name] = convertSecurityScheme(scheme);
  }
  if (Object.keys(schemeMethods).length === 0) return;

  if (!doc.paths) return;

  const securityEntries: Record<string, SecurityMethod[]> = {};
  const usedKeys = new Set<string>();

  // Document-level security requirements.
  const docSecurity = doc.security as Array<Record<string, unknown>> | undefined;

  for (const [pathStr, pathItemRaw] of sortedEntries(doc.paths)) {
    if (pathStr.startsWith("x-") || !pathItemRaw || typeof pathItemRaw !== "object") continue;
    const pathItem = pathItemRaw as Record<string, unknown>;

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== "object") continue;
      const opObj = op as OpenAPIOperation;

      const opKey = deriveOperationKey(opObj, pathStr, method, usedKeys);
      usedKeys.add(opKey);
      const bindingKey = `${opKey}.${DEFAULT_SOURCE_NAME}`;

      // Operation-level security overrides document-level.
      const opSecurity = (opObj as Record<string, unknown>).security as
        | Array<Record<string, unknown>>
        | undefined;
      const requirements = opSecurity ?? docSecurity;
      if (!requirements || requirements.length === 0) continue;

      // Collect scheme names from all requirements.
      const schemeNames: string[] = [];
      for (const req of requirements) {
        for (const schemeName of Object.keys(req)) {
          schemeNames.push(schemeName);
        }
      }
      if (schemeNames.length === 0) {
        // Empty security requirement means explicitly public.
        continue;
      }
      schemeNames.sort();

      const secKey = schemeNames.join("+");

      // Build the security entry if not already present.
      if (!securityEntries[secKey]) {
        const methods: SecurityMethod[] = [];
        for (const name of schemeNames) {
          if (schemeMethods[name]) {
            methods.push(schemeMethods[name]);
          }
        }
        if (methods.length === 0) continue;
        securityEntries[secKey] = methods;
      }

      // Link the binding.
      const binding = iface.bindings?.[bindingKey];
      if (binding) {
        binding.security = secKey;
      }
    }
  }

  if (Object.keys(securityEntries).length > 0) {
    iface.security = securityEntries;
  }
}

/** Converts an OpenAPI security scheme to an OBI SecurityMethod. */
function convertSecurityScheme(s: OpenAPISecurityScheme): SecurityMethod {
  switch (s.type) {
    case "http": {
      const scheme = (s.scheme ?? "").toLowerCase();
      switch (scheme) {
        case "bearer":
          return { type: "bearer", description: s.description || undefined };
        case "basic":
          return { type: "basic", description: s.description || undefined };
        default:
          return { type: s.scheme ?? s.type, description: s.description || undefined };
      }
    }

    case "oauth2": {
      const m: SecurityMethod = { type: "oauth2", description: s.description || undefined };
      if (s.flows) {
        // Use the first non-null flow, in preference order.
        const flow: OpenAPIOAuthFlow | undefined =
          s.flows.authorizationCode ??
          s.flows.implicit ??
          s.flows.clientCredentials ??
          s.flows.password;
        if (flow) {
          if (flow.authorizationUrl) m.authorizeUrl = flow.authorizationUrl;
          if (flow.tokenUrl) m.tokenUrl = flow.tokenUrl;
          if (flow.scopes) {
            const scopes = Object.keys(flow.scopes).sort();
            if (scopes.length > 0) m.scopes = scopes;
          }
        }
      }
      return m;
    }

    case "apiKey":
      return {
        type: "apiKey",
        description: s.description || undefined,
        name: s.name,
        in: s.in as SecurityMethod["in"],
      };

    case "openIdConnect":
      return { type: "bearer", description: "OpenID Connect" };

    default:
      return { type: s.type, description: s.description || undefined };
  }
}

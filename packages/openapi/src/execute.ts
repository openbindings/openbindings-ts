import type {
  BindingExecutionInput,
  ExecuteOutput,
  ExecutionOptions,
} from "@openbindings/sdk";
import {
  maybeJSON,
  isHttpUrl,
  contextBearerToken,
  contextApiKey,
  contextBasicAuth,
  normalizeContextKey,
  httpErrorCode,
  ERR_INVALID_REF,
  ERR_SOURCE_LOAD_FAILED,
  ERR_SOURCE_CONFIG_ERROR,
  ERR_REF_NOT_FOUND,
  ERR_EXECUTION_FAILED,
  ERR_RESPONSE_ERROR,
} from "@openbindings/sdk";
import type { OpenAPIDocument, OpenAPIOperation, OpenAPIParameter } from "./types.js";
import { errorMessage, loadOpenAPIDocument, mergeParameters, parseRef } from "./util.js";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Executes an OpenAPI binding by resolving the ref, building the HTTP request, and returning the response. */
export async function executeBinding(
  input: BindingExecutionInput,
  options?: { signal?: AbortSignal },
  preloadedDoc?: OpenAPIDocument,
): Promise<ExecuteOutput> {
  const start = performance.now();

  let doc: OpenAPIDocument;
  if (preloadedDoc) {
    doc = preloadedDoc;
  } else {
    try {
      doc = await loadOpenAPIDocument(input.source.location, input.source.content, options, input.fetch);
    } catch (e: unknown) {
      return failedOutput(start, ERR_SOURCE_LOAD_FAILED, errorMessage(e));
    }
  }

  let path: string, method: string;
  try {
    ({ path, method } = parseRef(input.ref));
  } catch (e: unknown) {
    return failedOutput(start, ERR_INVALID_REF, errorMessage(e));
  }

  let baseURL: string;
  try {
    baseURL = resolveBaseURLWithLocation(doc, input.options, input.source.location);
  } catch (e: unknown) {
    return failedOutput(start, ERR_SOURCE_CONFIG_ERROR, errorMessage(e));
  }

  if (!doc.paths) {
    return failedOutput(start, ERR_SOURCE_CONFIG_ERROR, "OpenAPI document has no paths defined");
  }
  const pathItem = doc.paths[path];
  if (!pathItem) {
    return failedOutput(start, ERR_REF_NOT_FOUND, `path "${path}" not in OpenAPI doc`);
  }
  const op = pathItem[method] as OpenAPIOperation | undefined;
  if (!op) {
    return failedOutput(start, ERR_REF_NOT_FOUND, `method "${method}" not in path "${path}"`);
  }

  return doHTTPRequest(doc, op, pathItem, path, method, baseURL, input, start, options);
}

async function doHTTPRequest(
  doc: OpenAPIDocument,
  op: OpenAPIOperation,
  pathItem: Record<string, unknown>,
  pathTemplate: string,
  method: string,
  baseURL: string,
  input: BindingExecutionInput,
  start: number,
  options?: { signal?: AbortSignal },
): Promise<ExecuteOutput> {
  const allParams = mergeParameters(
    pathItem["parameters"] as OpenAPIParameter[] | undefined,
    op.parameters,
  );
  const inputMap = asInputRecord(input.input);

  const { resolvedPath, query, headers: headerParams, body } = classifyInput(allParams, inputMap, pathTemplate);

  let reqURL = baseURL + resolvedPath;
  if (Object.keys(query).length > 0) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      q.set(k, String(v));
    }
    reqURL += "?" + q.toString();
  }

  const fetchHeaders = new Headers();
  fetchHeaders.set("Accept", "application/json");

  for (const [k, v] of Object.entries(headerParams)) {
    fetchHeaders.set(k, String(v));
  }

  const authQueryParams = applyContext(fetchHeaders, doc, op, input.context, input.options);
  if (authQueryParams) {
    const sep = reqURL.includes("?") ? "&" : "?";
    reqURL += sep + new URLSearchParams(authQueryParams).toString();
  }

  const hasBody = op.requestBody != null;
  let fetchBody: string | FormData | undefined;
  if (hasBody) {
    const useMultipart = isMultipartRequest(op);
    if (useMultipart) {
      fetchBody = buildFormData(body, op);
      // Do not set Content-Type; let the runtime set it with the boundary
    } else {
      fetchBody = JSON.stringify(body);
      fetchHeaders.set("Content-Type", "application/json");
    }
  }

  const doFetch = input.fetch ?? fetch;
  let resp: Response;
  try {
    resp = await doFetch(reqURL, {
      method: method.toUpperCase(),
      headers: fetchHeaders,
      body: fetchBody,
      signal: options?.signal,
    });
  } catch (e: unknown) {
    return failedOutput(start, ERR_EXECUTION_FAILED, errorMessage(e));
  }

  let respText: string;
  try {
    respText = await readResponseText(resp, MAX_RESPONSE_BYTES);
  } catch (e: unknown) {
    return failedOutput(start, ERR_RESPONSE_ERROR, errorMessage(e));
  }

  const durationMs = Math.round(performance.now() - start);

  let output: unknown;
  if (respText.length > 0) {
    if (maybeJSON(respText)) {
      try {
        output = JSON.parse(respText);
      } catch {
        output = respText;
      }
    } else {
      output = respText;
    }
  }

  if (resp.status >= 400) {
    return {
      output,
      status: resp.status,
      durationMs,
      error: {
        code: httpErrorCode(resp.status),
        message: `HTTP ${resp.status} ${resp.statusText}`,
      },
    };
  }

  return { output, status: resp.status, durationMs };
}

interface SecurityScheme {
  type?: string;
  scheme?: string;
  name?: string;
  in?: string;
  flows?: {
    authorizationCode?: {
      authorizationUrl?: string;
      tokenUrl?: string;
      scopes?: Record<string, string>;
    };
    [key: string]: unknown;
  };
}

function resolveSecuritySchemes(
  doc: OpenAPIDocument,
  op: OpenAPIOperation,
): SecurityScheme[] {
  const opSec = op.security as Array<Record<string, unknown>> | undefined;
  const docSec = (doc as Record<string, unknown>)["security"] as Array<Record<string, unknown>> | undefined;
  const requirements = opSec ?? docSec;
  if (!requirements?.length) return [];

  const components = (doc as Record<string, unknown>)["components"] as Record<string, unknown> | undefined;
  const securitySchemes = components?.["securitySchemes"] as Record<string, SecurityScheme> | undefined;
  if (!securitySchemes) return [];

  const result: SecurityScheme[] = [];
  const seen = new Set<string>();

  for (const req of requirements) {
    for (const schemeName of Object.keys(req)) {
      if (seen.has(schemeName)) continue;
      seen.add(schemeName);
      const scheme = securitySchemes[schemeName];
      if (scheme) result.push(scheme);
    }
  }

  return result;
}

/**
 * Extracts the server origin from an OpenAPI doc and normalizes it as a
 * stable context store key via normalizeContextKey.
 */
export function resolveServerKey(
  doc: OpenAPIDocument,
  sourceLocation?: string,
): string {
  if (doc.servers?.length && doc.servers[0].url) {
    let serverURL = doc.servers[0].url as string;
    if (!serverURL.startsWith("http://") && !serverURL.startsWith("https://")) {
      if (sourceLocation && isHttpUrl(sourceLocation)) {
        try {
          const parsed = new URL(sourceLocation);
          serverURL = parsed.origin + serverURL;
        } catch { /* fall through */ }
      }
    }
    return normalizeContextKey(serverURL.replace(/\/+$/, ""));
  }
  return "";
}

function asInputRecord(input: unknown): Record<string, unknown> {
  if (input == null) return {};
  if (Array.isArray(input)) return {};
  if (typeof input === "object") return input as Record<string, unknown>;
  return {};
}

function resolveBaseURL(doc: OpenAPIDocument, opts?: ExecutionOptions): string {
  const metaBase = opts?.metadata?.["baseURL"];
  if (typeof metaBase === "string" && metaBase) {
    return metaBase.replace(/\/+$/, "");
  }
  if (Array.isArray(doc.servers) && doc.servers.length > 0) {
    const url = doc.servers[0].url;
    if (typeof url === "string" && url) {
      return url.replace(/\/+$/, "");
    }
  }
  throw new Error("no server URL: set servers in the OpenAPI doc or provide baseURL in execution options metadata");
}

function resolveBaseURLWithLocation(
  doc: OpenAPIDocument,
  opts?: ExecutionOptions,
  sourceLocation?: string,
): string {
  const base = resolveBaseURL(doc, opts);
  if (base.startsWith("http://") || base.startsWith("https://")) return base;
  if (sourceLocation && isHttpUrl(sourceLocation)) {
    try {
      const parsed = new URL(sourceLocation);
      return (parsed.origin + base).replace(/\/+$/, "");
    } catch { /* fall through */ }
  }
  return base;
}

interface ParamClassification {
  resolvedPath: string;
  query: Record<string, unknown>;
  headers: Record<string, unknown>;
  body: Record<string, unknown>;
}

function classifyInput(
  params: OpenAPIParameter[],
  input: Record<string, unknown>,
  pathTemplate: string,
): ParamClassification {
  const query: Record<string, unknown> = {};
  const headers: Record<string, unknown> = {};
  const body: Record<string, unknown> = {};

  const paramClassification = new Map<string, string>();
  for (const p of params) {
    if (p?.name && p?.in) paramClassification.set(p.name, p.in);
  }

  let resolvedPath = pathTemplate;
  for (const [name, value] of Object.entries(input)) {
    const classification = paramClassification.get(name);
    if (!classification) {
      body[name] = value;
      continue;
    }
    switch (classification) {
      case "path":
        resolvedPath = resolvedPath.replaceAll(`{${name}}`, String(value));
        break;
      case "query":
        query[name] = value;
        break;
      case "header":
        headers[name] = value;
        break;
      default:
        body[name] = value;
    }
  }

  return { resolvedPath, query, headers, body };
}

/**
 * Applies opaque binding context (credentials via well-known fields) and
 * execution options (headers, cookies) to fetch headers, using OpenAPI
 * securitySchemes for spec-driven credential placement.
 */
function applyContext(
  headers: Headers,
  doc: OpenAPIDocument,
  op: OpenAPIOperation,
  ctx?: Record<string, unknown>,
  opts?: ExecutionOptions,
): Record<string, string> | undefined {
  let queryParams: Record<string, string> | undefined;

  if (ctx) {
    const result = applyCredentialsViaSchemes(headers, doc, op, ctx);
    if (!result.applied) {
      applyCredentialsFallback(headers, ctx);
    }
    queryParams = result.queryParams;
  }

  if (opts?.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      headers.set(k, v);
    }
  }

  if (opts?.cookies) {
    const cookieParts: string[] = [];
    for (const [k, v] of Object.entries(opts.cookies)) {
      cookieParts.push(`${k}=${encodeURIComponent(v)}`);
    }
    if (cookieParts.length > 0) {
      headers.append("Cookie", cookieParts.join("; "));
    }
  }

  return queryParams;
}

function applyCredentialsViaSchemes(
  headers: Headers,
  doc: OpenAPIDocument,
  op: OpenAPIOperation,
  ctx: Record<string, unknown>,
): { applied: boolean; queryParams?: Record<string, string> } {
  const schemes = resolveSecuritySchemes(doc, op);
  if (!schemes.length) return { applied: false };

  let applied = false;
  let queryParams: Record<string, string> | undefined;

  for (const scheme of schemes) {
    switch (scheme.type) {
      case "apiKey": {
        const val = contextApiKey(ctx);
        if (!val) continue;
        switch (scheme.in) {
          case "header":
            headers.set(scheme.name ?? "Authorization", val);
            applied = true;
            break;
          case "query":
            if (scheme.name) {
              queryParams ??= {};
              queryParams[scheme.name] = val;
              applied = true;
            }
            break;
          case "cookie":
            if (scheme.name) {
              headers.append("Cookie", `${scheme.name}=${encodeURIComponent(val)}`);
              applied = true;
            }
            break;
        }
        break;
      }
      case "http":
        switch ((scheme.scheme ?? "").toLowerCase()) {
          case "bearer": {
            const token = contextBearerToken(ctx);
            if (token) {
              headers.set("Authorization", `Bearer ${token}`);
              applied = true;
            }
            break;
          }
          case "basic": {
            const basic = contextBasicAuth(ctx);
            if (basic) {
              const encoded = btoa(`${basic.username}:${basic.password}`);
              headers.set("Authorization", `Basic ${encoded}`);
              applied = true;
            }
            break;
          }
        }
        break;
    }
  }

  return { applied, queryParams };
}

function applyCredentialsFallback(headers: Headers, ctx: Record<string, unknown>): void {
  const token = contextBearerToken(ctx);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
    return;
  }
  const basic = contextBasicAuth(ctx);
  if (basic) {
    const encoded = btoa(`${basic.username}:${basic.password}`);
    headers.set("Authorization", `Basic ${encoded}`);
    return;
  }
  const apiKey = contextApiKey(ctx);
  if (apiKey) {
    headers.set("Authorization", `ApiKey ${apiKey}`);
  }
}

/**
 * Returns true when the operation's requestBody should use multipart/form-data
 * encoding. Prefers application/json when both content types are declared.
 */
function isMultipartRequest(op: OpenAPIOperation): boolean {
  const content = op.requestBody?.content;
  if (!content) return false;
  if ("application/json" in content) return false;
  return "multipart/form-data" in content;
}

/**
 * Builds a FormData instance from the body record. Properties whose schema
 * declares `type: "string"` + `format: "binary"` are expected to already be
 * Blob/File values; everything else is appended as a string.
 */
function buildFormData(body: Record<string, unknown>, op: OpenAPIOperation): FormData {
  const fd = new FormData();
  const schema = op.requestBody?.content?.["multipart/form-data"]?.schema;
  const props: Record<string, Record<string, unknown>> =
    (schema?.["properties"] as Record<string, Record<string, unknown>> | undefined) ?? {};

  for (const [key, value] of Object.entries(body)) {
    if (value == null) continue;
    const propSchema = props[key];
    const isBinary =
      propSchema?.["type"] === "string" && propSchema?.["format"] === "binary";
    if (isBinary && value instanceof Blob) {
      fd.append(key, value);
    } else {
      fd.append(key, String(value));
    }
  }
  return fd;
}

async function readResponseText(resp: Response, maxBytes: number): Promise<string> {
  if (!resp.body) return resp.text();

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`response exceeds ${maxBytes} byte limit`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }

  return chunks.join("");
}

function failedOutput(startMs: number, code: string, message: string): ExecuteOutput {
  return {
    status: 1,
    durationMs: Math.round(performance.now() - startMs),
    error: { code, message },
  };
}

import {
  InvocationError,
  contextRequiredError,
  contextSatisfies,
  maybeJSON,
  isHttpUrl,
  contextBearerToken,
  contextApiKey,
  contextBasicAuth,
  contextString,
  contextHeaders,
  contextCookies,
  contextMetadata,
  normalizeEndpoint,
  httpErrorCode,
  ERR_INVALID_REF,
  ERR_SOURCE_CONFIG_ERROR,
  ERR_REF_NOT_FOUND,
  ERR_EXECUTION_FAILED,
  ERR_RESPONSE_ERROR,
  ERR_MISSING_INPUT,
  type BindingHandle,
  type BindingInvocationArgs,
  type ContextAlternative,
  type ContextRequirement,
  type ContextRequiredDetails,
  type Metadata,
} from "@openbindings/sdk";
import type {
  OpenAPIDocument,
  OpenAPIOperation,
  OpenAPIParameter,
  OpenAPISecurityScheme,
} from "./types.js";
import { errorMessage, mergeParameters, parseRef } from "./util.js";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Drives one OpenAPI binding invocation over the binding-facing handle:
 * resolves the ref against the document, derives auth requirements, reads
 * the input message (if any) from the handle, performs the HTTP request,
 * and emits the parsed response body.
 *
 * Every pre-dispatch failure (bad ref, missing server URL, unresolvable
 * operation, missing context) terminates the handle BEFORE any network
 * side effect, so a no-input-consumed retry is safe.
 */
export async function runBinding(
  args: BindingInvocationArgs,
  inv: BindingHandle<unknown, unknown>,
  doc: OpenAPIDocument,
): Promise<void> {
  let path: string, method: string;
  try {
    ({ path, method } = parseRef(args.ref));
  } catch (e: unknown) {
    inv.fireError(new InvocationError(ERR_INVALID_REF, errorMessage(e)));
    return;
  }

  let baseURL: string;
  try {
    baseURL = resolveRequestBaseURL(doc, args.context, args.source.location);
  } catch (e: unknown) {
    inv.fireError(new InvocationError(ERR_SOURCE_CONFIG_ERROR, errorMessage(e)));
    return;
  }

  if (!doc.paths) {
    inv.fireError(
      new InvocationError(ERR_SOURCE_CONFIG_ERROR, "OpenAPI document has no paths defined"),
    );
    return;
  }
  const pathItem = doc.paths[path];
  if (!pathItem) {
    inv.fireError(new InvocationError(ERR_REF_NOT_FOUND, `path "${path}" not in OpenAPI doc`));
    return;
  }
  const op = pathItem[method] as OpenAPIOperation | undefined;
  if (!op) {
    inv.fireError(
      new InvocationError(ERR_REF_NOT_FOUND, `method "${method}" not in path "${path}"`),
    );
    return;
  }

  // Context negotiation: challenge before any input is depended on and
  // before any request is dispatched.
  const details = requiredContext(doc, op, args.context, baseURL);
  if (details) {
    inv.fireError(contextRequiredError(requirementSummary(details), details));
    return;
  }

  // ----- Input (flows through the handle, not the args) -----
  const allParams = mergeParameters(pathItem.parameters, op.parameters);
  const takesInput = allParams.length > 0 || op.requestBody != null;

  let inputMap: Record<string, unknown>;
  if (!takesInput) {
    // No-input operation: close input on entry so the caller never has to,
    // and dispatch immediately.
    void inv.closeInput();
    inputMap = {};
  } else {
    const first = await readFirst(inv.inputs());
    void inv.closeInput();
    if (first === undefined) {
      if (requiresInput(allParams, op)) {
        inv.fireError(
          new InvocationError(
            ERR_MISSING_INPUT,
            `operation "${method} ${path}" requires an input message`,
          ),
        );
        return;
      }
      inputMap = {};
    } else {
      inputMap = asInputRecord(first);
    }
  }

  await doHTTPRequest(doc, op, allParams, path, method, baseURL, inputMap, args, inv);
}

/** Reads the first input message from the handle, or undefined when the input side closed bare. */
async function readFirst<T>(inputs: AsyncIterable<T>): Promise<T | undefined> {
  for await (const v of inputs) {
    return v;
  }
  return undefined;
}

/** True when the operation cannot be dispatched without an input message. */
function requiresInput(params: OpenAPIParameter[], op: OpenAPIOperation): boolean {
  return params.some((p) => p?.required === true) || op.requestBody?.required === true;
}

async function doHTTPRequest(
  doc: OpenAPIDocument,
  op: OpenAPIOperation,
  allParams: OpenAPIParameter[],
  pathTemplate: string,
  method: string,
  baseURL: string,
  inputMap: Record<string, unknown>,
  args: BindingInvocationArgs,
  inv: BindingHandle<unknown, unknown>,
): Promise<void> {
  const { resolvedPath, query, headers: headerParams, body } = classifyInput(
    allParams,
    inputMap,
    pathTemplate,
  );

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

  const authQueryParams = applyContext(fetchHeaders, doc, op, args.context);
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

  const doFetch = args.fetch ?? fetch;
  let resp: Response;
  try {
    resp = await doFetch(reqURL, {
      method: method.toUpperCase(),
      headers: fetchHeaders,
      body: fetchBody,
      signal: inv.signal,
    });
  } catch (e: unknown) {
    inv.fireError(new InvocationError(ERR_EXECUTION_FAILED, errorMessage(e)));
    return;
  }

  let respText: string;
  try {
    respText = await readResponseText(resp, MAX_RESPONSE_BYTES);
  } catch (e: unknown) {
    inv.fireError(new InvocationError(ERR_RESPONSE_ERROR, errorMessage(e)));
    return;
  }

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

  // Cancelled while in flight: the handle is already terminal.
  if (inv.signal.aborted) return;

  // Leading metadata (HTTP response headers) precedes the first emit.
  inv.setHeader(responseMetadata(resp));

  if (resp.status >= 400) {
    inv.fireError(
      new InvocationError(
        httpErrorCode(resp.status),
        `HTTP ${resp.status} ${resp.statusText}`,
        { status: resp.status, body: output },
      ),
    );
    return;
  }

  await inv.emitOutput(output);
  inv.closeOutput();
}

/** Converts fetch Response headers into multi-valued invocation metadata. */
function responseMetadata(resp: Response): Metadata {
  const md: Metadata = {};
  resp.headers.forEach((value, key) => {
    const existing = md[key];
    if (existing) {
      existing.push(value);
    } else {
      md[key] = [value];
    }
  });
  return md;
}

// ---------------------------------------------------------------------------
// Context requirements (openbindings.binding-invoker role negotiation)
// ---------------------------------------------------------------------------

/**
 * Derives the context requirements for an operation from the OpenAPI
 * document's securitySchemes and the operation's (or document's) security
 * requirements, and checks them against the supplied context. Returns the
 * CONTEXT_REQUIRED details when the context is insufficient, or null when
 * no auth is required or the context satisfies one alternative.
 *
 * Each OpenAPI security-requirement object (an AND of schemes) becomes one
 * alternative; the array of requirement objects is the OR.
 */
export function requiredContext(
  doc: OpenAPIDocument,
  op: OpenAPIOperation,
  ctx: Record<string, unknown> | undefined,
  baseURL: string,
): ContextRequiredDetails | null {
  const alternatives = securityAlternatives(doc, op);
  if (!alternatives) return null;
  const details: ContextRequiredDetails = {
    key: normalizeEndpoint(baseURL),
    alternatives,
  };
  if (ctx && contextSatisfies(ctx, details)) return null;
  return details;
}

function securityAlternatives(
  doc: OpenAPIDocument,
  op: OpenAPIOperation,
): ContextAlternative[] | null {
  const opSec = op.security as Array<Record<string, unknown>> | undefined;
  const docSec = (doc as Record<string, unknown>)["security"] as
    | Array<Record<string, unknown>>
    | undefined;
  // Operation-level security replaces document-level entirely (including
  // an explicit empty array, which removes auth for the operation).
  const requirements = opSec ?? docSec;
  if (!requirements?.length) return null;

  const components = (doc as Record<string, unknown>)["components"] as
    | Record<string, unknown>
    | undefined;
  const securitySchemes = components?.["securitySchemes"] as
    | Record<string, OpenAPISecurityScheme>
    | undefined;

  const alternatives: ContextAlternative[] = [];
  for (const req of requirements) {
    const names = Object.keys(req);
    // An empty security-requirement object means unauthenticated access is
    // allowed: the OR is trivially satisfiable, so no context is required.
    if (names.length === 0) return null;

    const reqs: ContextRequirement[] = [];
    let expressible = true;
    for (const name of names.sort()) {
      const scheme = securitySchemes?.[name];
      const type = scheme ? requirementType(scheme) : null;
      if (!type) {
        expressible = false;
        break;
      }
      reqs.push({ type });
    }
    // A requirement set containing a scheme we cannot express cannot be
    // satisfied through context negotiation; skip the whole alternative
    // (it is an AND).
    if (!expressible || reqs.length === 0) continue;
    alternatives.push({ requirements: reqs });
  }
  return alternatives.length > 0 ? alternatives : null;
}

/** Maps an OpenAPI security scheme to a standard context-requirement family. */
function requirementType(scheme: OpenAPISecurityScheme): string | null {
  switch (scheme.type) {
    case "http":
      switch ((scheme.scheme ?? "").toLowerCase()) {
        case "bearer":
          return "auth.bearer";
        case "basic":
          return "auth.basic";
        default:
          return null;
      }
    case "apiKey":
      return "auth.apiKey";
    case "oauth2":
      return "auth.oauth2";
    case "openIdConnect":
      return "auth.bearer";
    default:
      return null;
  }
}

function requirementSummary(details: ContextRequiredDetails): string {
  const types = [
    ...new Set(details.alternatives.flatMap((a) => a.requirements.map((r) => r.type))),
  ];
  return `${types.join(" or ")} required`;
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

function asInputRecord(input: unknown): Record<string, unknown> {
  if (input == null) return {};
  if (Array.isArray(input)) return {};
  if (typeof input === "object") return input as Record<string, unknown>;
  return {};
}

function resolveBaseURL(doc: OpenAPIDocument, ctx?: Record<string, unknown>): string {
  const metaBase = contextMetadata(ctx)["baseURL"];
  if (typeof metaBase === "string" && metaBase) {
    return metaBase.replace(/\/+$/, "");
  }
  if (Array.isArray(doc.servers) && doc.servers.length > 0) {
    const url = doc.servers[0].url;
    if (typeof url === "string" && url) {
      return url.replace(/\/+$/, "");
    }
  }
  throw new Error("no server URL: set servers in the OpenAPI doc or provide baseURL in context metadata");
}

/**
 * Resolves the request base URL from context metadata or the document's
 * servers, resolving relative server URLs against the source location.
 * Throws when no server URL can be determined.
 */
export function resolveRequestBaseURL(
  doc: OpenAPIDocument,
  ctx?: Record<string, unknown>,
  sourceLocation?: string,
): string {
  const base = resolveBaseURL(doc, ctx);
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
): Record<string, string> | undefined {
  let queryParams: Record<string, string> | undefined;

  if (ctx) {
    const result = applyCredentialsViaSchemes(headers, doc, op, ctx);
    if (!result.applied) {
      applyCredentialsFallback(headers, ctx);
    }
    queryParams = result.queryParams;
    for (const [k, v] of Object.entries(contextHeaders(ctx))) {
      headers.set(k, v);
    }
    const cookies = contextCookies(ctx);
    const cookieParts: string[] = [];
    for (const [k, v] of Object.entries(cookies)) {
      cookieParts.push(`${k}=${encodeURIComponent(v)}`);
    }
    if (cookieParts.length > 0) {
      headers.append("Cookie", cookieParts.join("; "));
    }
  }

  return queryParams;
}

function resolveSecuritySchemes(
  doc: OpenAPIDocument,
  op: OpenAPIOperation,
): OpenAPISecurityScheme[] {
  const opSec = op.security as Array<Record<string, unknown>> | undefined;
  const docSec = (doc as Record<string, unknown>)["security"] as Array<Record<string, unknown>> | undefined;
  const requirements = opSec ?? docSec;
  if (!requirements?.length) return [];

  const components = (doc as Record<string, unknown>)["components"] as Record<string, unknown> | undefined;
  const securitySchemes = components?.["securitySchemes"] as Record<string, OpenAPISecurityScheme> | undefined;
  if (!securitySchemes) return [];

  const result: OpenAPISecurityScheme[] = [];
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
      case "oauth2":
      case "openIdConnect": {
        const token = contextString(ctx, "accessToken") || contextBearerToken(ctx);
        if (token) {
          headers.set("Authorization", `Bearer ${token}`);
          applied = true;
        }
        break;
      }
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

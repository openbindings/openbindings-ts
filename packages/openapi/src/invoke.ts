import {
  InvocationError,
  contextRequiredError,
  contextSatisfies,
  isHttpUrl,
  isJSONContentType,
  classifyThroughHooks,
  decodeThroughHooks,
  contextBearerToken,
  contextApiKey,
  contextBasicAuth,
  contextString,
  contextHeaders,
  contextCookies,
  contextMetadata,
  httpErrorCode,
  ERR_INVALID_REF,
  ERR_SOURCE_CONFIG_ERROR,
  ERR_REF_NOT_FOUND,
  ERR_CONNECT_FAILED,
  ERR_RESPONSE_ERROR,
  ERR_MISSING_INPUT,
  USE_DEFAULT,
  type BindingHandle,
  type InvokeHooks,
  type InvokeSite,
  type OutputDecoder,
  type RawResult,
  type ResultClassifier,
  type BindingInvocationArgs,
  type ContextAlternative,
  type ContextRequirement,
  type ContextRequiredDetails,
  type Metadata,
} from "@openbindings/sdk";
import type {
  OpenAPIDocument,
  OpenAPIMediaType,
  OpenAPIOperation,
  OpenAPIParameter,
  OpenAPISecurityScheme,
  OpenAPIOAuthFlow,
} from "./types.js";
import { errorMessage, mergeParameters, parseRef } from "./util.js";
import { isSSEContentType, streamSSE } from "./sse.js";

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
    // Prose only; the SDK's InvocationError appends the requirement facts
    // (target + satisfying context fields), matching the Go format.
    inv.fireError(
      contextRequiredError("OpenAPI operation requires authentication context", details),
    );
    return;
  }

  // ----- Input (flows through the handle, not the args) -----
  const allParams = mergeParameters(pathItem.parameters, op.parameters);
  const takesInput = allParams.length > 0 || op.requestBody != null;

  let inputMap: Record<string, unknown>;
  if (args.binding !== undefined && args.inputSchema === undefined) {
    // Operation-layer no-input convention: the binding is populated but no
    // input schema is, so the operation declares NO input — the caller never
    // writes nor closes. Close input on entry and dispatch with an empty
    // input, overriding whatever the OpenAPI document declares.
    void inv.closeInput();
    inputMap = {};
  } else if (!takesInput) {
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
    bodyPropertyNames(op),
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
  // Accept both JSON and Server-Sent Events. Servers that support SSE will
  // return text/event-stream when streaming; otherwise we get JSON as
  // before (Go parity: runBinding sets the same Accept value).
  fetchHeaders.set("Accept", "application/json, text/event-stream");

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
    // Aborted while in flight: the handle is already terminal (caller
    // cancel or another terminal transition); stay silent.
    if (inv.signal.aborted) return;
    // The request never produced a response: a transport-level failure.
    inv.fireError(new InvocationError(ERR_CONNECT_FAILED, errorMessage(e)));
    return;
  }

  // Leading metadata (HTTP response headers) precedes the first emit.
  const invocationMeta = responseMetadata(resp);
  inv.setHeader(invocationMeta);

  const contentType = resp.headers.get("content-type");
  const site = siteFor(args, baseURL);

  // SSE dispatch: a 2xx response with text/event-stream content type is a
  // streaming response. Hand the (still-open) response to the SSE streamer,
  // which takes ownership of reading/closing the body and the terminal
  // transition (Go parity: runBinding's isSSEContentType gate, run once
  // here on the initial response status, before any body read).
  if (resp.status >= 200 && resp.status < 300 && isSSEContentType(contentType)) {
    await streamSSE(resp, args, site, inv, invocationMeta, decodeByContentType(contentType));
    return;
  }

  let respText: string;
  try {
    respText = await readResponseText(resp, MAX_RESPONSE_BYTES);
  } catch (e: unknown) {
    if (inv.signal.aborted) return;
    inv.fireError(new InvocationError(ERR_RESPONSE_ERROR, errorMessage(e)));
    return;
  }

  // Cancelled while in flight: the handle is already terminal.
  if (inv.signal.aborted) return;

  // Classify, then decode — both through the consultation seam
  // (per-invocation hook → invoker-level hook → the format builtins
  // below). The conventions record's pinned rules (recommended built-in
  // defaults, spec/formats/README.md), content-independent throughout:
  // classify = success iff status ∈ 2xx (declared `responses` never change
  // classification — they enrich failure details); decode = the response's
  // Content-Type HEADER decides the lane (wire framing, not payload
  // sniffing): JSON for application/json and +json suffixes, text
  // otherwise, absent/unparseable header → text.
  const raw: RawResult = { status: resp.status, body: respText, meta: invocationMeta };

  let ok: boolean;
  try {
    ok = await classifyThroughHooks(args.hooks, site, raw, builtinClassify);
  } catch (e: unknown) {
    inv.fireError(toInvocationError(e));
    return;
  }
  if (!ok) {
    // The format's NATIVE failure: hooks change the verdict, never the
    // error vocabulary. The raw body rides details for callers.
    inv.fireError(
      new InvocationError(
        httpErrorCode(resp.status),
        `HTTP ${resp.status} ${resp.statusText}`,
        { status: resp.status, ...(respText.length > 0 ? { body: respText } : {}) },
      ),
    );
    return;
  }

  let output: unknown;
  try {
    output = await decodeThroughHooks(args.hooks, site, raw, decodeByContentType(contentType));
  } catch (e: unknown) {
    inv.fireError(toInvocationError(e));
    return;
  }

  // Success provenance stamps (per the conventions record's recommended
  // built-in defaults, spec/formats/README.md): decode provenance is
  // header/content-type when the builtin (the Content-Type lane) decided,
  // hook when overridden; classify is always assumption/2xx unless a hook
  // widened it.
  inv.setTrailer(decodeClassifyTrailer(args.hooks, "header/content-type"));
  await inv.emitOutput(output);
  inv.closeOutput();
}

/**
 * The openapi builtin result classifier: success iff the HTTP status is
 * 2xx (the convention floor; declared responses refine failure DETAILS
 * only, never classification).
 */
export function builtinClassify(_site: InvokeSite, raw: RawResult): boolean | typeof USE_DEFAULT {
  return raw.status != null && raw.status >= 200 && raw.status < 300;
}

/**
 * Returns the builtin decoder for one response's declared Content-Type
 * header: strict JSON for application/json and +json suffixes (a
 * declared-JSON body that fails to parse is a lying server — a loud
 * ERR_RESPONSE_ERROR, never a silent string); text otherwise; an empty
 * body is a null output.
 */
export function decodeByContentType(contentType: string | null): OutputDecoder {
  const isJSON = isJSONContentType(contentType);
  return (_site: InvokeSite, raw: RawResult): unknown => {
    if (raw.body.length === 0) return null;
    if (isJSON) {
      try {
        return JSON.parse(raw.body);
      } catch (e: unknown) {
        throw new InvocationError(
          ERR_RESPONSE_ERROR,
          `response declares ${JSON.stringify(contentType)} but the body is not valid JSON: ${errorMessage(e)}`,
        );
      }
    }
    return raw.body;
  };
}

/**
 * Completes the site for one dispatch with the format-known target (the
 * resolved base URL). A missing site (direct format-package call) gets a
 * minimal one so hook tables keyed on format/ref still match.
 */
function siteFor(args: BindingInvocationArgs, baseURL: string): InvokeSite {
  const site: InvokeSite = args.site
    ? { ...args.site }
    : {
        operation: args.binding?.operation ?? "",
        invokedAs: args.binding?.operation ?? "",
        bindingKey: "",
        format: args.source.format,
        ref: args.ref,
        target: "",
      };
  if (site.target === "") site.target = baseURL;
  return site;
}

/**
 * Builds the x-ob-decode/x-ob-classify success stamps (the provenance the
 * conventions record's recommended built-in defaults call for,
 * spec/formats/README.md) for the HTTP lane, given the decode axis's
 * builtin provenance token. A hook decision on either axis stamps "hook".
 */
function decodeClassifyTrailer(hooks: InvokeHooks | null | undefined, builtinDecode: string): Metadata {
  let decode = builtinDecode;
  let classify = "assumption/2xx";
  if (hooks?.decodeDecidedBy() === "hook") decode = "hook";
  if (hooks?.classifyDecidedBy() === "hook") classify = "hook";
  return { "x-ob-decode": [decode], "x-ob-classify": [classify] };
}

/** Converts a seam failure into the terminal InvocationError to surface. */
function toInvocationError(e: unknown): InvocationError {
  if (e instanceof InvocationError) return e;
  return new InvocationError(ERR_RESPONSE_ERROR, errorMessage(e));
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
  const alternatives = securityAlternatives(doc, op, baseURL);
  if (!alternatives) return null;
  const details: ContextRequiredDetails = {
    target: baseURL,
    alternatives,
  };
  if (ctx && contextSatisfies(ctx, details)) return null;
  return details;
}

function securityAlternatives(
  doc: OpenAPIDocument,
  op: OpenAPIOperation,
  baseURL: string,
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
      const requirement = scheme ? schemeRequirement(scheme, baseURL) : null;
      if (!requirement) {
        expressible = false;
        break;
      }
      reqs.push(requirement);
    }
    // A requirement set containing a scheme we cannot express cannot be
    // satisfied through context negotiation; skip the whole alternative
    // (it is an AND).
    if (!expressible || reqs.length === 0) continue;
    alternatives.push({ requirements: reqs });
  }
  return alternatives.length > 0 ? alternatives : null;
}

/**
 * Maps an OpenAPI security scheme to a standard context requirement, carrying
 * the family-specific fields a resolver needs to act without out-of-band
 * knowledge (notably oauth2 flow endpoints). Returns null for schemes that
 * cannot be expressed as a known requirement family.
 */
function schemeRequirement(
  scheme: OpenAPISecurityScheme,
  baseURL: string,
): ContextRequirement | null {
  switch (scheme.type) {
    case "http":
      switch ((scheme.scheme ?? "").toLowerCase()) {
        case "bearer":
          return { type: "auth.bearer" };
        case "basic":
          return { type: "auth.basic" };
        default:
          return null;
      }
    case "apiKey":
      return { type: "auth.apiKey" };
    case "oauth2":
      return oauth2Requirement(scheme, baseURL);
    case "openIdConnect": {
      // OpenID Connect resolves to an OAuth2 access token. The discovery URL
      // lets a resolver fetch the authorize/token endpoints.
      const req: ContextRequirement = { type: "auth.oauth2" };
      if (scheme.openIdConnectUrl) {
        req.openIdConnectUrl = absolutize(scheme.openIdConnectUrl, baseURL);
      }
      return req;
    }
    default:
      return null;
  }
}

/**
 * Builds an `auth.oauth2` requirement carrying the flow's authorize/token URLs
 * and scopes under the role's convention field names (`authorizeUrl`,
 * `tokenUrl`, `scopes`). Prefers the authorization-code flow — the only
 * interactive, PKCE-capable flow — then implicit, then password, then
 * clientCredentials: a fixed priority (mirroring the Go SDK's
 * oauth2Requirement exactly), not object/declaration order, so the same
 * scheme resolves to the same flow regardless of how it was authored. The
 * token-only fallback keys on `tokenUrl` (not `authorizationUrl`) so
 * password and clientCredentials — which define only `tokenUrl` — are
 * selected; keying on `authorizationUrl` skipped them, yielding a bare
 * `auth.oauth2` requirement with no `tokenUrl`/`scopes`. Relative URLs are
 * resolved against the server base.
 */
function oauth2Requirement(
  scheme: OpenAPISecurityScheme,
  baseURL: string,
): ContextRequirement {
  const req: ContextRequirement = { type: "auth.oauth2" };
  const flows = scheme.flows;
  const tokenOnlyFlow = [flows?.password, flows?.clientCredentials].find(
    (f): f is OpenAPIOAuthFlow => !!f && typeof f.tokenUrl === "string",
  );
  const flow = flows?.authorizationCode ?? flows?.implicit ?? tokenOnlyFlow;
  if (flow?.authorizationUrl) req.authorizeUrl = absolutize(flow.authorizationUrl, baseURL);
  if (flow?.tokenUrl) req.tokenUrl = absolutize(flow.tokenUrl, baseURL);
  if (flow?.scopes && Object.keys(flow.scopes).length > 0) {
    req.scopes = Object.keys(flow.scopes);
  }
  return req;
}

/** Resolves a possibly-relative URL against the server base; passes absolute URLs through. */
function absolutize(url: string, baseURL: string): string {
  try {
    return new URL(url, baseURL).toString();
  } catch {
    return url;
  }
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

/**
 * The JSON request body's declared top-level property names. Used for the
 * field-collision rule: a flattened input field that is both a parameter
 * and a body property is delivered to both wire locations. The document is
 * dereferenced at load, so schema values are direct.
 */
function bodyPropertyNames(op: OpenAPIOperation): Set<string> | undefined {
  const content = op.requestBody?.content;
  if (!content) return undefined;
  for (const [contentType, media] of Object.entries(content)) {
    const mt = contentType.split(";", 1)[0].trim();
    if (mt !== "application/json" && !mt.endsWith("+json")) continue;
    const props = (media as OpenAPIMediaType | undefined)?.schema?.properties;
    if (!props || typeof props !== "object") return undefined;
    return new Set(Object.keys(props));
  }
  return undefined;
}

function classifyInput(
  params: OpenAPIParameter[],
  input: Record<string, unknown>,
  pathTemplate: string,
  bodyProps?: Set<string>,
): ParamClassification {
  const query: Record<string, unknown> = {};
  const headers: Record<string, unknown> = {};
  const body: Record<string, unknown> = {};
  const cookies: Record<string, unknown> = {};

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
        // Encode so a value containing `/`, `?`, or `#` cannot corrupt the
        // request URL's path/query structure.
        resolvedPath = resolvedPath.replaceAll(`{${name}}`, encodeURIComponent(String(value)));
        break;
      case "query":
        query[name] = value;
        break;
      case "header":
        headers[name] = value;
        break;
      case "cookie":
        cookies[name] = value;
        break;
      default:
        body[name] = value;
    }
    // One name, one value, delivered to EVERY declared wire location: a
    // field that is both a parameter and a body property (PUT /users/{id}
    // with id in the body) rides the parameter location AND stays in the
    // body — the flattened contract says what, the wire locations are
    // plumbing.
    if (bodyProps?.has(name)) {
      body[name] = value;
    }
  }

  // Declared cookie params travel in a Cookie header (sorted for a
  // deterministic value), never in the body. Context-supplied cookies are
  // appended separately by applyContext via headers.append (Go parity:
  // classifyInput's Cookie-header composition).
  if (Object.keys(cookies).length > 0) {
    const names = Object.keys(cookies).sort();
    headers["Cookie"] = names.map((n) => `${n}=${cookies[n]}`).join("; ");
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
        // Cancel the body stream before bailing; releasing the lock alone
        // leaves the response socket pinned on the remaining bytes.
        await reader.cancel().catch(() => {});
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

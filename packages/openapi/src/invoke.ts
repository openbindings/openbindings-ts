import {
  InvocationError,
  contextRequiredError,
  configValueRequirement,
  contextSatisfies,
  classifyThroughHooks,
  decodeThroughHooks,
  contextBearerToken,
  contextApiKey,
  contextApiKeyFor,
  contextBasicAuth,
  contextString,
  contextHeaders,
  contextCookies,
  contextConfiguration,
  httpErrorCode,
  ERR_INVALID_REF,
  ERR_SOURCE_CONFIG_ERROR,
  ERR_REF_NOT_FOUND,
  ERR_CONNECT_FAILED,
  ERR_RESPONSE_ERROR,
  ERR_MISSING_INPUT,
  ERR_VALIDATION_FAILED,
  ERR_PROTOCOL,
  USE_DEFAULT,
  type BindingHandle,
  type InvokeHooks,
  type InvokeSite,
  type OutputDecoder,
  type RawResult,
  type BindingInvocationArgs,
  type ContextAlternative,
  type ContextRequirement,
  type ContextRequiredDetails,
  type Metadata,
  resolveDeliveryUnitLimit,
} from "@openbindings/sdk";
import type {
  OpenAPIDocument,
  OpenAPIOperation,
  OpenAPIParameter,
  OpenAPISecurityScheme,
  OpenAPIOAuthFlow,
  OpenAPIOAuthFlows,
} from "./types.js";
import { errorMessage, parseRef } from "./util.js";
import {
  MissingPathParamError,
  effectiveParameters,
  queryEscape,
  routeInput,
  unflattenableParam,
} from "./params.js";
import { BINDING_SPEC_V2 } from "./constants.js";
import {
  envelopeWillEmitBody,
  flatInputHasAmbiguousParameter,
  parseRoutedEnvelope,
  routeEnvelope,
  validateEnvelopeRoutes,
  type RoutedEnvelope,
} from "./input-routes-v2.js";
import {
  acceptHeader,
  buildRequestBody,
  candidateCollides,
  governingResponse,
  governingResponseMedia,
  isJSONMediaType,
  normalizeMediaType,
  parseMediaType,
  planRequestBodies,
  type BodyPlan,
} from "./media.js";
import { ConfigRequired, resolveServer } from "./servers.js";

/**
 * Maps a server-resolution failure to the right terminal: a resolvable-missing
 * configuration value (a ConfigRequired signal) becomes a config.value
 * CONTEXT_REQUIRED challenge — retryable after resolution (R1a) — while any
 * other error stays a terminal ERR_SOURCE_CONFIG_ERROR. resolveServer already
 * consulted the supplied context; the operation-invoker's bounded
 * resolve-and-retry loop is the backstop. No server target has resolved, so
 * the challenge carries an empty target; a resolver may satisfy it
 * interactively or from caller-owned policy, but must not invent a reusable
 * target.
 */
function configOrSourceError(e: unknown): InvocationError {
  if (e instanceof ConfigRequired) {
    return contextRequiredError(e.message, {
      target: "",
      alternatives: [
        { requirements: [configValueRequirement(e.point, e.key, e.message, e.choices, e.durable)] },
      ],
    });
  }
  return new InvocationError(ERR_SOURCE_CONFIG_ERROR, errorMessage(e));
}
import { isSSEContentType, streamSSE } from "./sse.js";

/**
 * Drives one OpenAPI binding invocation over the binding-facing handle: one
 * HTTP exchange per invocation (openbindings.openapi@1 §8). All
 * pre-dispatch refusals — bad ref, unresolvable operation, unflattenable
 * declarations, out-of-family request media, unresolvable server, missing
 * context, missing path parameters, unmatched input fields, credential
 * collisions — terminate the handle BEFORE any network side effect, and
 * before consuming input where knowable.
 */
export async function runBinding(
  args: BindingInvocationArgs,
  inv: BindingHandle<unknown, unknown>,
  doc: OpenAPIDocument,
): Promise<void> {
  // ----- Pre-side-effect resolution. -----

  let path: string, method: string;
  try {
    ({ path, method } = parseRef(args.ref));
  } catch (e: unknown) {
    inv.fireError(new InvocationError(ERR_INVALID_REF, errorMessage(e)));
    return;
  }

  if (!doc.paths) {
    inv.fireError(
      new InvocationError(ERR_SOURCE_CONFIG_ERROR, "OpenAPI document has no paths defined"),
    );
    return;
  }
  // Pointer evaluation follows OAS reference resolution (OAPI-D-03): the
  // loader dereferences path-item $refs (including 3.1 components.pathItems
  // targets) at load, before this lookup.
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

  const revision2 = args.source.bindingSpec === BINDING_SPEC_V2;
  // Revision 2 lifts cross-location name collisions through its routed
  // source value. Case-distinct declarations that HTTP itself treats as one
  // header name remain unresolvable in both revisions.
  const params = effectiveParameters(pathItem, op);
  const unflattenable = unflattenableParam(params, args.source.bindingSpec);
  if (unflattenable !== "") {
    inv.fireError(
      new InvocationError(
        ERR_SOURCE_CONFIG_ERROR,
        `operation declares parameter "${unflattenable}" without a distinct wire identity under ${args.source.bindingSpec} (OAPI-P-03, unflattenable/unresolvable)`,
      ),
    );
    return;
  }
  let baseURL: string;
  try {
    baseURL = resolveServer(doc, pathItem, op, args.context, args.source.location);
  } catch (e: unknown) {
    inv.fireError(configOrSourceError(e));
    return;
  }

  // CONTEXT_REQUIRED is raised before any input is consumed and before any
  // network I/O, so a no-input-consumed retry (after the operation layer
  // resolves context) is safe.
  const details = requiredContext(doc, op, args.context, baseURL);
  if (details) {
    inv.fireError(
      contextRequiredError("OpenAPI operation requires authentication context", details),
    );
    return;
  }

  // A required body will necessarily consult request-media selection. Its
  // candidate set is artifact-only, so an unsupported/degenerate set is a
  // knowable pre-dispatch refusal and must not wait for caller input.
  let requiredBodyPlans: BodyPlan[] | undefined;
  if (op.requestBody?.required === true) {
    try {
      requiredBodyPlans = planRequestBodies(op);
    } catch (e: unknown) {
      inv.fireError(new InvocationError(ERR_SOURCE_CONFIG_ERROR, errorMessage(e)));
      return;
    }
  }

  // ----- Input flows through the handle, not the args. Whether this
  // interaction carries an input value is decided by the ARTIFACT and by what
  // the caller writes — never by the presence of the operation's `input`
  // member. Core §6.2: schema absence "means the document makes no portable
  // claim at that boundary", not that the interaction carries zero values. A
  // caller with nothing to say says it by closing. -----
  let inputMap: Record<string, unknown>;
  let envelope: RoutedEnvelope | null = null;
  let inputSupplied = false;
  if (params.length === 0 && op.requestBody == null) {
    // No-input operation: close input on entry so the caller never has to,
    // and dispatch immediately.
    void inv.closeInput();
    inputMap = {};
  } else {
    const first = await readFirst(inv.inputs());
    void inv.closeInput();
    if (first === undefined) {
      // Bare close: with a required parameter or required requestBody the
      // dispatch cannot succeed — fire ERR_MISSING_INPUT before any
      // network I/O (cross-SDK parity). Otherwise parameters and body are
      // optional; proceed with an empty input.
      const missing = requiredInputMissing(params, op);
      if (missing !== "") {
        inv.fireError(new InvocationError(ERR_MISSING_INPUT, missing));
        return;
      }
      inputMap = {};
    } else {
      inputSupplied = true;
      if (revision2) {
        try {
          envelope = parseRoutedEnvelope(first);
        } catch (e: unknown) {
          inv.fireError(new InvocationError(ERR_VALIDATION_FAILED, errorMessage(e)));
          return;
        }
      }
      if (envelope === null) {
        if (first === null || typeof first !== "object" || Array.isArray(first)) {
          inv.fireError(new InvocationError(ERR_VALIDATION_FAILED, "OpenAPI input value must be a JSON object"));
          return;
        }
        inputMap = first as Record<string, unknown>;
      } else {
        inputMap = {};
      }
    }
  }

  // ----- Routing (§9.1) and body construction (§9.2): still pre-dispatch. -----

  if (revision2 && inputSupplied && envelope === null && flatInputHasAmbiguousParameter(params, inputMap)) {
    inv.fireError(new InvocationError(
      ERR_VALIDATION_FAILED,
      "this revision-2 input supplies one flat field for independently declared same-named parameters and requires a routed source input (normally produced by the binding's inputTransform)",
    ));
    return;
  }

  let plans: BodyPlan[] = [];
  const willEmitBody = envelope
    ? envelopeWillEmitBody(envelope, op)
    : requestWillEmitBody(params, inputMap, op);
  if (willEmitBody || envelope) {
    try {
      plans = requiredBodyPlans ?? planRequestBodies(op);
    } catch (e: unknown) {
      inv.fireError(new InvocationError(ERR_SOURCE_CONFIG_ERROR, errorMessage(e)));
      return;
    }
  }
  if (envelope) {
    try {
      validateEnvelopeRoutes(params, plans, envelope);
    } catch (e: unknown) {
      inv.fireError(new InvocationError(ERR_VALIDATION_FAILED, errorMessage(e)));
      return;
    }
  }
  if (!willEmitBody) plans = [];

  let routed: ReturnType<typeof routeInput> | undefined;
  let wire: ReturnType<typeof buildRequestBody> | undefined;
  let routeFailure: unknown;
  const reasons: string[] = [];
  const candidates = plans.length === 0
    ? [null]
    : configuredRequestPlans(plans, args.context);
  for (const candidate of candidates) {
    if (envelope === null && candidate && candidateCollides(params, candidate)) {
      reasons.push(
        `request media candidate ${candidate.mediaType} collides with an independently declared parameter`,
      );
      continue;
    }
    try {
      const candidateRouted = envelope
        ? routeEnvelope(params, envelope, path, candidate)
        : routeInput(params, inputMap, path, candidate);
      const candidateWire = buildRequestBody(doc, candidate, candidateRouted);
      routed = candidateRouted;
      wire = candidateWire;
      break;
    } catch (e: unknown) {
      if (e instanceof MissingPathParamError) {
        routeFailure = e;
        break;
      }
      reasons.push(`${candidate?.mediaType ?? "no body"}: ${errorMessage(e)}`);
    }
  }
  if (!routed || !wire) {
    const failure = routeFailure ?? new Error(
      `no request media candidate can carry this invocation: ${
        reasons.length > 0 ? reasons.join("; ") : "configured requestMedia selects no declared supported candidate"
      }`,
    );
    const code = failure instanceof MissingPathParamError ? ERR_MISSING_INPUT : ERR_VALIDATION_FAILED;
    inv.fireError(new InvocationError(code, errorMessage(failure)));
    return;
  }

  // ----- Channel assembly (§9.6, OAPI-P-10). -----

  const placements = credentialPlacements(doc, op, args.context);
  const collision = credentialCollision(placements, params, routed.populated);
  if (collision !== "") {
    inv.fireError(new InvocationError(ERR_VALIDATION_FAILED, collision));
    return;
  }

  const queryUnits = [...routed.queryUnits];
  const cookieUnits = [...routed.cookieUnits];
  for (const pl of placements) {
    if (pl.channel === "query") {
      queryUnits.push(queryEscape(pl.name, false) + "=" + queryEscape(pl.value, false));
    } else if (pl.channel === "cookie") {
      cookieUnits.push(pl.name + "=" + pl.value);
    }
  }
  // Context-supplied transport-hint cookies (consumer context, not
  // security-scheme credentials) ride after credentials, sorted for
  // determinism.
  const hintCookies = contextCookies(args.context);
  for (const k of Object.keys(hintCookies).sort()) {
    cookieUnits.push(`${k}=${hintCookies[k]}`);
  }

  let reqURL = baseURL + routed.resolvedPath;
  if (queryUnits.length > 0) {
    reqURL += "?" + queryUnits.join("&");
  }

  const fetchHeaders = new Headers();
  if (wire.contentType !== "") {
    fetchHeaders.set("Content-Type", wire.contentType);
  }
  // Advertise only artifact-declared concrete success media; an empty set
  // leaves Accept absent.
  const accept = acceptHeader(op);
  if (accept !== "") fetchHeaders.set("Accept", accept);

  for (const [k, v] of routed.headers) {
    fetchHeaders.set(k, v);
  }
  for (const pl of placements) {
    if (pl.channel === "header") {
      fetchHeaders.set(pl.name, pl.value);
    }
  }
  // Context-supplied transport-hint headers (consumer context) apply last.
  for (const [k, v] of Object.entries(contextHeaders(args.context))) {
    fetchHeaders.set(k, v);
  }
  // One Cookie header (OAPI-P-10): declared cookie parameters in
  // declaration order, credentials appended after.
  if (cookieUnits.length > 0) {
    fetchHeaders.set("Cookie", cookieUnits.join("; "));
  }

  const doFetch = args.fetch ?? fetch;
  let resp: Response;
  try {
    resp = await doFetch(reqURL, {
      method: method.toUpperCase(),
      headers: fetchHeaders,
      body: wire.body,
      signal: inv.signal,
      redirect: "manual",
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
  const responseDeclaration = governingResponse(op, resp.status);

  // Interaction-shape dispatch (§8, OAPI-P-06): the shape is bounded by
  // declaration and selected by framing. An operation is streaming-capable
  // iff a declared success response declares text/event-stream; for a
  // streaming-capable operation the response's Content-Type header — never
  // payload bytes — selects between server-streaming and unary. A
  // text/event-stream response on an operation that is NOT
  // streaming-capable contradicts the declaration: a protocol error, never
  // a silent reclassification.
  if (isSSEContentType(contentType)) {
    // Classification is independent of declaration lookup. A non-success
    // final status is the native HTTP failure even if its body happens to
    // use event-stream framing.
    let ok: boolean;
    try {
      ok = await classifyThroughHooks(
        args.hooks,
        site,
        { status: resp.status, body: "", meta: invocationMeta },
        builtinClassify,
      );
    } catch (e: unknown) {
      await resp.body?.cancel().catch(() => {});
      inv.fireError(toInvocationError(e));
      return;
    }
    if (!ok) {
      // A non-2xx event-stream response is one unsuccessful HTTP exchange,
      // not a stream of successful operation values. Preserve its exact
      // response bytes under the same consumer-owned delivery-unit bound as
      // the unary failure lane. Detecting SSE framing must never discard
      // native evidence.
      let failureBody: Uint8Array;
      try {
        failureBody = await readResponseBytes(resp, resolveDeliveryUnitLimit(args));
      } catch (e: unknown) {
        if (inv.signal.aborted) return;
        inv.fireError(new InvocationError(ERR_RESPONSE_ERROR, errorMessage(e)));
        return;
      }
      if (inv.signal.aborted) return;
      inv.fireError(
        new InvocationError(
          httpErrorCode(resp.status),
          "Invocation completed unsuccessfully",
          undefined,
          openAPIFailureDetails(
            resp,
            failureBody,
            failureBody.length > 0 ? new TextDecoder().decode(failureBody) : "",
            invocationMeta,
            responseDeclaration,
            contentType,
          ),
        ),
      );
      return;
    }
    let governingMedia: string | null;
    try {
      governingMedia = responseDeclaration
        ? governingResponseMedia(responseDeclaration.response, contentType)
        : null;
    } catch (e: unknown) {
      await resp.body?.cancel().catch(() => {});
      inv.fireError(
        new InvocationError(
          ERR_PROTOCOL,
          `response arrived as text/event-stream, but the governing response does not declare that media type: ${errorMessage(e)}`,
        ),
      );
      return;
    }
    if (!governingMedia || parseMediaType(governingMedia).base !== "text/event-stream") {
      await resp.body?.cancel().catch(() => {});
      inv.fireError(
        new InvocationError(
          ERR_PROTOCOL,
          "response arrived as text/event-stream, but the governing response does not declare that media type",
        ),
      );
      return;
    }
    inv.setTrailer({ "x-ob-governing-media": [governingMedia] });
    await streamSSE(resp, args, site, inv, invocationMeta, decodeByContentType(contentType));
    return;
  }

  let bodyBytes: Uint8Array;
  try {
    // The unary body is one delivery unit: the consumer-configurable
    // delivery-unit bound applies (args.maxDeliveryUnitBytes, default 10MB).
    bodyBytes = await readResponseBytes(resp, resolveDeliveryUnitLimit(args));
  } catch (e: unknown) {
    if (inv.signal.aborted) return;
    inv.fireError(new InvocationError(ERR_RESPONSE_ERROR, errorMessage(e)));
    return;
  }

  // Cancelled while in flight: the handle is already terminal.
  if (inv.signal.aborted) return;

  // Classify, then decode — both through the consultation seam
  // (per-invocation hook → invoker-level hook → the format builtins
  // below). The binding specification's defaults (OAPI-P-07/P-08),
  // content-independent throughout: classify = success iff status ∈ 2xx
  // (declared `responses` never change classification — they enrich
  // failure details); decode = the response's Content-Type HEADER decides
  // the lane (wire framing, not payload sniffing): JSON for
  // application/json and +json suffixes, the charset-honoring text lane
  // otherwise, absent/unparseable header → text.
  //
  // The seam's RawResult carries the unit's text; the builtin decoder
  // below closes over the BYTES, so the charset rule (OAPI-P-07) applies
  // to the wire bytes, not a pre-decoded string.
  const lossyText = bodyBytes.length > 0 ? new TextDecoder().decode(bodyBytes) : "";
  const raw: RawResult = { status: resp.status, body: lossyText, meta: invocationMeta };

  let ok: boolean;
  try {
    ok = await classifyThroughHooks(args.hooks, site, raw, builtinClassify);
  } catch (e: unknown) {
    inv.fireError(toInvocationError(e));
    return;
  }
  if (!ok) {
    // The format's NATIVE failure: hooks change the verdict, never the
    // error vocabulary. It is not an operation output, but the complete
    // native response and the OpenAPI declaration match remain available on
    // the failure completion. The legacy status/body members remain for
    // callers that already consume them.
    inv.fireError(
      new InvocationError(
        httpErrorCode(resp.status),
        "Invocation completed unsuccessfully",
        undefined,
        openAPIFailureDetails(
          resp,
          bodyBytes,
          lossyText,
          invocationMeta,
          responseDeclaration,
          contentType,
        ),
      ),
    );
    return;
  }

  // An empty successful response carries absence, not an invented null.
  if (bodyBytes.length === 0) {
    inv.setTrailer(decodeClassifyTrailer(args.hooks, "not-consulted/empty"));
    inv.closeOutput();
    return;
  }

  let governingMedia: string;
  try {
    if (!responseDeclaration) {
      throw new Error(`status ${resp.status} has no governing Response Object`);
    }
    governingMedia = governingResponseMedia(responseDeclaration.response, contentType) ?? "";
    if (!governingMedia) throw new Error("the governing Response Object declares no response content");
  } catch (e: unknown) {
    inv.fireError(new InvocationError(ERR_PROTOCOL, errorMessage(e)));
    return;
  }

  let output: unknown;
  try {
    output = await decodeThroughHooks(args.hooks, site, raw, decodeBytesByContentType(contentType, bodyBytes));
  } catch (e: unknown) {
    inv.fireError(toInvocationError(e));
    return;
  }

  // Success provenance stamps (conventions record): decode provenance is
  // header/content-type when the builtin (the Content-Type lane) decided,
  // hook when overridden; classify is always assumption/2xx unless a hook
  // widened it.
  const trailer = decodeClassifyTrailer(args.hooks, "header/content-type");
  trailer["x-ob-governing-media"] = [governingMedia];
  inv.setTrailer(trailer);
  await inv.emitOutput(output);
  inv.closeOutput();
}

/** Reads the first input message from the handle, or undefined when the input side closed bare. */
async function readFirst<T>(inputs: AsyncIterable<T>): Promise<T | undefined> {
  for await (const v of inputs) {
    return v;
  }
  return undefined;
}

/**
 * Reports why a bare input close cannot satisfy the operation: a non-empty
 * string names the first required parameter or the required request body.
 * Empty string means an empty request is dispatchable.
 */
function requiredInputMissing(params: OpenAPIParameter[], op: OpenAPIOperation): string {
  for (const p of params) {
    if (p?.required === true) {
      return `operation requires parameter "${p.name}"`;
    }
  }
  if (op.requestBody != null && op.requestBody.required === true) {
    return "operation requires a request body";
  }
  return "";
}

function requestWillEmitBody(
  params: OpenAPIParameter[],
  input: Record<string, unknown>,
  op: OpenAPIOperation,
): boolean {
  if (op.requestBody?.required === true) return true;
  if (op.requestBody == null) return false;
  const parameterNames = new Set(params.map((parameter) => parameter.name).filter((name): name is string => Boolean(name)));
  return Object.keys(input).some((name) => !parameterNames.has(name));
}

/** Applies the optional artifact-neutral request-media configuration point. */
function configuredRequestPlans(
  plans: BodyPlan[],
  ctx: Record<string, unknown> | undefined,
): BodyPlan[] {
  const raw = contextConfiguration(ctx)["requestMedia"];
  if (raw == null) return plans;
  if (typeof raw !== "string") return [];
  let wanted: string;
  try {
    wanted = parseMediaType(raw).identity;
  } catch {
    return [];
  }
  return plans.filter((plan) => {
    try {
      return parseMediaType(plan.mediaKey).identity === wanted;
    } catch {
      return false;
    }
  });
}

/**
 * The openapi builtin result classifier (OAPI-P-08): success iff the final
 * HTTP status is 2xx (declared responses refine failure DETAILS only,
 * never classification).
 */
export function builtinClassify(_site: InvokeSite, raw: RawResult): boolean | typeof USE_DEFAULT {
  return raw.status != null && raw.status >= 200 && raw.status < 300;
}

/**
 * Returns the builtin decoder implementing the header rule (OAPI-P-07)
 * over one delivery unit's TEXT (the SSE per-event lane): strict JSON for
 * application/json and +json suffixes (a declared-JSON body that fails to
 * parse is a lying server — a loud ERR_RESPONSE_ERROR, never a silent
 * string); the text itself otherwise; an empty unit is a null output.
 */
export function decodeByContentType(contentType: string | null): OutputDecoder {
  const isJSON = isJSONMediaType(normalizeMediaType(contentType ?? ""));
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
 * Returns the builtin decoder implementing the header rule (OAPI-P-07)
 * over the response BYTES: strict JSON for application/json and +json
 * suffixes; the charset-honoring text lane otherwise (UTF-8 default,
 * us-ascii/latin-1 supported, invalid sequences and unsupported charsets
 * are loud decode errors). An empty body (204 included) yields null.
 */
export function decodeBytesByContentType(
  contentType: string | null,
  bytes: Uint8Array,
): OutputDecoder {
  const isJSON = isJSONMediaType(normalizeMediaType(contentType ?? ""));
  return (_site: InvokeSite, _raw: RawResult): unknown => {
    if (bytes.length === 0) return null;
    if (isJSON) {
      try {
        return JSON.parse(new TextDecoder().decode(bytes));
      } catch (e: unknown) {
        throw new InvocationError(
          ERR_RESPONSE_ERROR,
          `response declares ${JSON.stringify(contentType)} but the body is not valid JSON: ${errorMessage(e)}`,
        );
      }
    }
    return decodeTextLane(contentType, bytes);
  };
}

/**
 * Decodes response bytes as text per the Content-Type header's charset
 * parameter, defaulting to UTF-8 (OAPI-P-07). Invalid sequences, and
 * charsets this implementation cannot decode, are loud decode errors — a
 * consumer needing another charset overrides at the decode configuration
 * point.
 */
export function decodeTextLane(contentType: string | null, bytes: Uint8Array): string {
  let charset = "utf-8";
  if (contentType) {
    const m = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType);
    if (m?.[1]) charset = m[1].trim();
  }
  switch (charset.toLowerCase()) {
    case "utf-8":
    case "utf8":
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new InvocationError(
          ERR_RESPONSE_ERROR,
          "response body is not valid UTF-8 (the declared/default charset)",
        );
      }
    case "us-ascii":
    case "ascii": {
      for (const [i, b] of bytes.entries()) {
        if (b >= 0x80) {
          throw new InvocationError(
            ERR_RESPONSE_ERROR,
            `response body byte ${i} is not valid US-ASCII (the declared charset)`,
          );
        }
      }
      return latin1String(bytes);
    }
    case "iso-8859-1":
    case "iso8859-1":
    case "latin-1":
    case "latin1":
      // True latin-1: each byte IS its code point (a TextDecoder
      // "iso-8859-1" label would decode windows-1252, which differs in
      // 0x80–0x9F).
      return latin1String(bytes);
    default:
      throw new InvocationError(
        ERR_RESPONSE_ERROR,
        `response declares charset ${JSON.stringify(charset)}, which this implementation cannot decode; override at the decode configuration point`,
      );
  }
}

function latin1String(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    out += String.fromCharCode(b);
  }
  return out;
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
        bindingSpec: args.source.bindingSpec,
        ref: args.ref,
        target: "",
      };
  if (site.target === "") site.target = baseURL;
  return site;
}

/**
 * Builds the x-ob-decode/x-ob-classify success stamps (the provenance the
 * conventions record's recommended built-in defaults call for,
 * spec/binding-specs/README.md) for the HTTP lane, given the decode axis's
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

/**
 * Builds the binding-native evidence carried by an unsuccessful OpenAPI HTTP
 * exchange. `httpResponse.body.base64` is the fidelity record: it preserves
 * arbitrary bytes through both in-process use and JSON invoker frames. The
 * older top-level `status`/`body` members remain a convenience text view.
 */
function openAPIFailureDetails(
  resp: Response,
  bodyBytes: Uint8Array | null,
  textView: string,
  metadata: Metadata,
  declaration: ReturnType<typeof governingResponse>,
  contentType: string | null,
): Record<string, unknown> {
  const httpResponse: Record<string, unknown> = {
    status: resp.status,
    headers: Object.fromEntries(
      Object.entries(metadata).map(([name, values]) => [name.toLowerCase(), [...values]]),
    ),
  };
  if (bodyBytes !== null) {
    httpResponse.body = {
      base64: bytesToBase64(bodyBytes),
      byteLength: bodyBytes.byteLength,
    };
  }
  if (resp.statusText !== "") httpResponse.statusText = resp.statusText;
  if (resp.url !== "") httpResponse.url = resp.url;

  const artifact: Record<string, unknown> = { declared: declaration !== null };
  if (declaration) {
    artifact.responseKey = declaration.key;
    try {
      const governingMedia = governingResponseMedia(declaration.response, contentType);
      if (governingMedia) artifact.governingMedia = governingMedia;
    } catch {
      // The mismatch is already preserved by the actual headers and matched
      // Response Object key. Failure evidence must not replace the native
      // status with a new decode/protocol failure.
    }
  }

  return {
    status: resp.status,
    ...(textView.length > 0 ? { body: textView } : {}),
    httpResponse,
    openapi: artifact,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
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
      if (!scheme) {
        // The security requirement names a scheme that components.securitySchemes
        // never declares: an unresolvable reference, not checkable, not
        // enforced — never degraded into a weaker requirement. This is
        // distinct from a resolved scheme with an unrecognized type (R2.c
        // ruling), which schemeRequirement always surfaces below.
        expressible = false;
        break;
      }
      reqs.push(schemeRequirement(scheme, baseURL, name));
    }
    // A requirement set containing an unresolvable scheme reference cannot
    // be expressed through context negotiation at all; skip the whole
    // alternative (it is an AND). A scheme that resolves but maps to no
    // known family is NOT skipped — schemeRequirement surfaces it as a typed
    // "auth.<T>" requirement instead (R2.c ruling), so the alternative stays
    // discoverable even though the built-in satisfaction check can never
    // select it (contextSatisfies treats an unrecognized type as
    // unsatisfiable).
    if (!expressible || reqs.length === 0) continue;
    alternatives.push({ requirements: reqs });
  }
  return alternatives.length > 0 ? alternatives : null;
}

/**
 * Maps an OpenAPI security scheme to a context requirement, carrying the
 * family-specific fields a resolver needs to act without out-of-band
 * knowledge (notably oauth2 flow endpoints), the requirement's `name` (the
 * securitySchemes key — rule A), and its `description` when the artifact
 * declares one. Every scheme maps to SOMETHING: a recognized family, or —
 * per the R2.c ruling — a surfaced `auth.<T>` requirement for a scheme this
 * invoker has no resolver for, so the alternative stays discoverable (a
 * runtime with a resolver for that family could still satisfy it) instead of
 * being silently dropped. A document whose every alternative is unmappable
 * this way now produces a pre-dispatch CONTEXT_REQUIRED challenge instead of
 * dispatching unauthenticated into a blind 401.
 */
function schemeRequirement(
  scheme: OpenAPISecurityScheme,
  baseURL: string,
  name: string,
): ContextRequirement {
  const req = mapScheme(scheme, baseURL);
  req.name = name;
  if (scheme.description) req.description = scheme.description;
  return req;
}

/** The type-specific mapping schemeRequirement wraps with name/description. */
function mapScheme(scheme: OpenAPISecurityScheme, baseURL: string): ContextRequirement {
  switch (scheme.type) {
    case "http": {
      const httpScheme = (scheme.scheme ?? "").toLowerCase();
      if (httpScheme === "bearer") return { type: "auth.bearer" };
      if (httpScheme === "basic") return { type: "auth.basic" };
      // An http scheme this invoker cannot itself apply (e.g. digest): surface
      // it typed by the artifact's own scheme name (R2.c ruling), never drop it.
      return { type: httpScheme ? `auth.http.${httpScheme}` : "auth.http" };
    }
    case "apiKey":
      return { type: "auth.apiKey" };
    case "oauth2":
      return oauth2Requirement(scheme, baseURL);
    case "openIdConnect": {
      // OpenID Connect resolves to an OAuth2 access token. The discovery URL
      // lets a resolver fetch the authorize/token endpoints. No flows are
      // declared on an openIdConnect scheme, so no grantType is selected.
      const req: ContextRequirement = { type: "auth.oauth2" };
      if (scheme.openIdConnectUrl) {
        req.openIdConnectUrl = absolutize(scheme.openIdConnectUrl, baseURL);
      }
      return req;
    }
    default:
      // Any other artifact type (e.g. mutualTLS): surface it verbatim as
      // "auth.<type>" (R2.c ruling) rather than dropping the alternative.
      return { type: `auth.${scheme.type}` };
  }
}

/**
 * Builds an `auth.oauth2` requirement carrying the flow's authorize/token URLs
 * and scopes under the role's convention field names (`authorizeUrl`,
 * `tokenUrl`, `scopes`), plus `grantType` naming the OAuth2 grant type of the
 * SELECTED flow (rule B). Prefers the authorization-code flow — the only
 * interactive, PKCE-capable flow — then implicit, then password, then
 * clientCredentials: a fixed priority (mirroring the Go SDK's
 * oauth2Requirement exactly), not object/declaration order, so the same
 * scheme resolves to the same flow regardless of how it was authored. The
 * token-only fallback keys on `tokenUrl` (not `authorizationUrl`) so
 * password and clientCredentials — which define only `tokenUrl` — are
 * selected; keying on `authorizationUrl` skipped them, yielding a bare
 * `auth.oauth2` requirement with no `tokenUrl`/`scopes`. Relative URLs are
 * resolved against the server base. No flow means no grantType: a bare
 * `auth.oauth2` requirement (e.g. an openIdConnect-derived one) never
 * fabricates a grant type it did not select.
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
  if (flow) req.grantType = grantTypeFor(flows, flow);
  return req;
}

/**
 * Names the OAuth2 grant type for the flow `oauth2Requirement` selected, per
 * the SAME fixed priority (authorizationCode > implicit > password >
 * clientCredentials). Identity comparison against the flows object recovers
 * which flow was picked without re-deriving the priority a second time.
 */
function grantTypeFor(flows: OpenAPIOAuthFlows | undefined, flow: OpenAPIOAuthFlow): string {
  if (flow === flows?.authorizationCode) return "authorization_code";
  if (flow === flows?.implicit) return "implicit";
  if (flow === flows?.password) return "password";
  return "client_credentials";
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
// Credentials and channel assembly (§9.6: OAPI-P-09 wire application,
// OAPI-P-10 channel assembly)
// ---------------------------------------------------------------------------

/**
 * One credential's wire application: which channel it rides (header,
 * query, or cookie) under which name.
 */
export interface CredentialPlacement {
  channel: "header" | "query" | "cookie";
  name: string;
  value: string;
}

/** A securityScheme paired with its addressable name (the securitySchemes key). */
interface NamedSecurityScheme {
  scheme: OpenAPISecurityScheme;
  name: string;
}

/**
 * The security schemes applicable to an operation, each paired with its
 * securitySchemes key. Operation-level security overrides top-level; falls
 * back to top-level if not set. Scheme names within each requirement
 * iterate sorted so placement order is deterministic.
 */
function resolveSecuritySchemes(
  doc: OpenAPIDocument,
  op: OpenAPIOperation,
): NamedSecurityScheme[] {
  const opSec = op.security as Array<Record<string, unknown>> | undefined;
  const docSec = (doc as Record<string, unknown>)["security"] as Array<Record<string, unknown>> | undefined;
  const requirements = opSec ?? docSec;
  if (!requirements?.length) return [];

  const components = (doc as Record<string, unknown>)["components"] as Record<string, unknown> | undefined;
  const securitySchemes = components?.["securitySchemes"] as Record<string, OpenAPISecurityScheme> | undefined;
  if (!securitySchemes) return [];

  const result: NamedSecurityScheme[] = [];
  const seen = new Set<string>();

  for (const req of requirements) {
    for (const schemeName of Object.keys(req).sort()) {
      if (seen.has(schemeName)) continue;
      seen.add(schemeName);
      const scheme = securitySchemes[schemeName];
      if (scheme) result.push({ scheme, name: schemeName });
    }
  }

  return result;
}

/**
 * Derives the credential wire applications for an operation from the
 * artifact's security declarations (read at invocation time, never
 * extracted into the OBI) and the supplied context (OAPI-P-09): an apiKey
 * scheme's credential rides its declared in/name; http basic and bearer,
 * oauth2, and openIdConnect ride the Authorization header. When the
 * document declares no security schemes, well-known context credentials
 * fall back to the Authorization header. Placements are computed BEFORE
 * dispatch so the OAPI-P-10 collision refusal can run pre-dispatch;
 * duplicate channel+name placements collapse to the first.
 */
export function credentialPlacements(
  doc: OpenAPIDocument,
  op: OpenAPIOperation,
  ctx: Record<string, unknown> | undefined,
): CredentialPlacement[] {
  if (!ctx || Object.keys(ctx).length === 0) return [];

  const placements: CredentialPlacement[] = [];
  const seen = new Set<string>();
  const add = (channel: CredentialPlacement["channel"], name: string, value: string): void => {
    const key = channel + "\0" + (channel === "header" ? name.toLowerCase() : name);
    if (seen.has(key)) return;
    seen.add(key);
    placements.push({ channel, name, value });
  };

  for (const { scheme, name: schemeName } of resolveSecuritySchemes(doc, op)) {
    switch (scheme.type) {
      case "apiKey": {
        // The requirement's addressable name (the securitySchemes key)
        // resolves the credential — distinct from scheme.name, which is
        // the WIRE placement name, not the lookup key.
        const val = contextApiKeyFor(ctx, schemeName);
        if (!val || !scheme.name) continue;
        if (scheme.in === "header" || scheme.in === "query" || scheme.in === "cookie") {
          add(scheme.in, scheme.name, val);
        }
        break;
      }
      case "http":
        switch ((scheme.scheme ?? "").toLowerCase()) {
          case "bearer": {
            const token = contextBearerToken(ctx);
            if (token) add("header", "Authorization", `Bearer ${token}`);
            break;
          }
          case "basic": {
            const basic = contextBasicAuth(ctx);
            if (basic) {
              add("header", "Authorization", `Basic ${btoa(`${basic.username}:${basic.password}`)}`);
            }
            break;
          }
        }
        break;
      case "oauth2":
      case "openIdConnect": {
        const token = contextString(ctx, "accessToken") || contextBearerToken(ctx);
        if (token) add("header", "Authorization", `Bearer ${token}`);
        break;
      }
    }
  }

  if (placements.length === 0) {
    // No scheme applied a credential (typically no securitySchemes
    // declared): well-known context credentials fall back to the
    // Authorization header.
    const token = contextBearerToken(ctx);
    const basic = contextBasicAuth(ctx);
    const apiKey = contextApiKey(ctx);
    if (token) {
      add("header", "Authorization", `Bearer ${token}`);
    } else if (basic) {
      add("header", "Authorization", `Basic ${btoa(`${basic.username}:${basic.password}`)}`);
    } else if (apiKey) {
      add("header", "Authorization", `ApiKey ${apiKey}`);
    }
  }
  return placements;
}

/**
 * The OAPI-P-10 refusal: a name collision between a credential and a
 * caller-populated declared parameter on the same channel is refused
 * before dispatch — loud, never a silent overwrite in either direction.
 * Header names compare case-insensitively. Returns the refusal message, or
 * "" when the channels are collision-free.
 */
export function credentialCollision(
  placements: CredentialPlacement[],
  params: OpenAPIParameter[],
  populated: { header: Set<string>; query: Set<string>; cookie: Set<string> },
): string {
  const declared = {
    header: new Set<string>(),
    query: new Set<string>(),
    cookie: new Set<string>(),
  };
  for (const parameter of params) {
    if (!parameter.name) continue;
    if (parameter.in === "header") declared.header.add(parameter.name.toLowerCase());
    else if (parameter.in === "query") declared.query.add(parameter.name);
    else if (parameter.in === "cookie") declared.cookie.add(parameter.name);
  }
  const processorOwned = new Set(["host", "content-length", "content-type", "accept"]);
  const seen = new Set<string>();
  for (const pl of placements) {
    const name = pl.channel === "header" ? pl.name.toLowerCase() : pl.name;
    if (pl.channel === "header" && processorOwned.has(name)) {
      return `credential "${pl.name}" collides with processor-owned request field ${pl.name} (OAPI-P-10)`;
    }
    if (declared[pl.channel].has(name) || populated[pl.channel].has(name)) {
      return `credential "${pl.name}" collides with an effective ${pl.channel} parameter of the same name (OAPI-P-10: refused before dispatch, never a silent overwrite in either direction)`;
    }
    const key = `${pl.channel}\0${name}`;
    if (seen.has(key)) return `two credentials collide at ${pl.channel} "${pl.name}" (OAPI-P-10)`;
    seen.add(key);
  }
  return "";
}

// ---------------------------------------------------------------------------
// Response reading
// ---------------------------------------------------------------------------

async function readResponseBytes(resp: Response, maxBytes: number): Promise<Uint8Array> {
  if (!resp.body) {
    return new Uint8Array(await resp.arrayBuffer());
  }

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
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
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Preflight support (prepareBinding)
// ---------------------------------------------------------------------------

/**
 * Resolves the pieces prepareBinding needs from a loaded document: the
 * addressed operation and its resolved base URL. Returns null when the ref
 * does not resolve or the server cannot (the invocation surfaces those as
 * its own pre-dispatch refusals; there is no context to report).
 */
export function preflightTarget(
  doc: OpenAPIDocument,
  ref: string,
  ctx: Record<string, unknown> | undefined,
  sourceLocation: string | undefined,
): { op: OpenAPIOperation; baseURL: string } | null {
  let path: string, method: string;
  try {
    ({ path, method } = parseRef(ref));
  } catch {
    return null;
  }
  const pathItem = doc.paths?.[path];
  const op = pathItem?.[method] as OpenAPIOperation | undefined;
  if (!pathItem || !op) return null;
  try {
    return { op, baseURL: resolveServer(doc, pathItem, op, ctx, sourceLocation) };
  } catch {
    return null;
  }
}

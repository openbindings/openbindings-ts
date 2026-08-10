/**
 * AsyncAPI binding execution over the cardinality-agnostic invocation handle.
 *
 * The action is read from the DESCRIBED APPLICATION's perspective — AsyncAPI
 * 3.0's own rule — and an invocation is the counterparty (ASYNC-P-02,
 * spec/binding-specs/asyncapi): invoking a `send` operation SUBSCRIBES to
 * what the application sends; invoking a `receive` operation PUBLISHES what
 * the application expects to receive. The artifact is never read as
 * describing the invoker.
 *
 * One entrypoint ({@link runBinding}) drives every cell against the
 * binding-facing {@link BindingHandle}:
 *
 *   - receive + http/https  unary publish: one input -> request body using
 *                           the http binding's declared method,
 *                           response -> at most one output
 *   - receive + ws/wss      client-streaming publish: every input -> one
 *                           socket frame; the caller closing input ends it
 *   - send + http/https     excluded in revision 1
 *   - send + ws/wss         server-streaming subscription: socket frames
 *                           -> outputs, no caller input values
 *
 * All pre-dispatch failures (bad ref, no resolvable server, missing
 * context, an unresolved address or server variable, an unsatisfied
 * ws-binding declaration, an excluded input content family, missing publish
 * input) are raised via `fireError` BEFORE any network I/O, per the
 * binding-author contract and ASYNC-P-02/-03/-04's pre-dispatch refusals.
 */

import {
  InvocationError,
  contextRequiredError,
  configValueRequirement,
  contextSatisfies,
  contextBearerToken,
  contextApiKeyFor,
  contextBasicAuth,
  contextString,
  contextHeaders,
  contextCookies,
  contextConfiguration,
  httpErrorCode,
  ERR_INVALID_REF,
  ERR_PROTOCOL,
  ERR_SOURCE_CONFIG_ERROR,
  ERR_REF_NOT_FOUND,
  ERR_MISSING_INPUT,
  ERR_CONNECT_FAILED,
  ERR_RESPONSE_ERROR,
  ERR_STREAM_ERROR,
  ERR_VALIDATION_FAILED,
  type BindingHandle,
  type BindingInvocationArgs,
  type ContextAlternative,
  type ContextRequirement,
  type ContextRequiredDetails,
  type Metadata,
  isJSONContentType,
  decodeThroughHooks,
  resolveDeliveryUnitLimit,
  type InvokeHooks,
  type InvokeSite,
  type OutputDecoder,
  type RawResult,
} from "@openbindings/sdk";
import type {
  AsyncAPIChannel,
  AsyncAPIDocument,
  AsyncAPIOperation,
  AsyncAPIOAuthFlow,
  AsyncAPIOAuthFlows,
  AsyncAPISecurityScheme,
  AsyncAPIServer,
} from "./asyncapi-types.js";
import { isSecurityScheme } from "./asyncapi-types.js";
import { REF_NAME_TAG, preservesSendReplies } from "./constants.js";
import {
  mergeQuery,
  protocolFieldValues,
  requestMethod,
  resolveHTTPQuery,
  resolveWSUpgrade,
} from "./bindings.js";
import {
  decodeContentType,
  encodeInput,
  governingMessages,
  isWellFormedUnicode,
  normalizeMediaType,
  resolveReplyContentType,
  validateMessageBindingVersion,
  resolveInputCodec,
  selectedInputMessages,
  type InputCodec,
} from "./content.js";
import { streamSSE } from "./sse.js";
import { replyMessagesBindable } from "./synthesize.js";
import {
  addressConfiguration,
  channelNameOf,
  ConfigRequired,
  joinURL,
  resolveAddress,
  resolveTarget,
  type ResolvedTarget,
} from "./target.js";

/**
 * Maps a resolution failure to the right terminal: a resolvable-missing
 * configuration value (a ConfigRequired signal) becomes a config.value
 * CONTEXT_REQUIRED challenge — retryable after resolution (R1a) — while any
 * other error stays a terminal ERR_SOURCE_CONFIG_ERROR. resolveTarget/
 * resolveAddress already consulted the supplied context and found the value
 * absent, so the challenge fires unconditionally; the operation-invoker's
 * bounded resolve-and-retry loop is the backstop. The resolved server URL
 * when known is the strongest available scope; configuration is not assumed
 * public, so a resolver decides whether that scope is sufficient.
 */
function configOrSourceError(e: unknown, serverURL: string): InvocationError {
  if (e instanceof ConfigRequired) {
    return contextRequiredError(e.message, {
      target: serverURL,
      alternatives: [
        {
          requirements: [
            configValueRequirement(e.point, e.key, e.message, e.choices, e.durable),
          ],
        },
      ],
    });
  }
  return new InvocationError(ERR_SOURCE_CONFIG_ERROR, errorMessage(e));
}
import { parseRef, errorMessage } from "./util.js";
import type { PooledWS, WSPool } from "./ws-pool.js";

/**
 * STAYS FIXED under the delivery-unit knob: this constant now caps only the
 * DIAGNOSTICS-side failure-body capture (readErrorBody) — error details,
 * never an emitted output value, so the consumer bound does not apply.
 */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

type Handle = BindingHandle<unknown, unknown>;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Resolves the operation, checks runtime context, and dispatches to the
 * protocol-specific runner. Terminates the handle exactly once.
 */
export async function runBinding(
  args: BindingInvocationArgs,
  h: Handle,
  doc: AsyncAPIDocument,
  wsPool: WSPool,
): Promise<void> {
  let opID: string;
  try {
    opID = parseRef(args.ref);
  } catch (e: unknown) {
    h.fireError(new InvocationError(ERR_INVALID_REF, errorMessage(e)));
    return;
  }

  const asyncOp = (doc.operations ?? {})[opID];
  if (!asyncOp) {
    h.fireError(
      new InvocationError(ERR_REF_NOT_FOUND, `operation "${opID}" not in AsyncAPI doc`),
    );
    return;
  }

  // The binding target is the addressed operation's channel (§8), reached
  // through a resolved server and expanded address (§9.2). A channel `$ref`
  // the dereferencer could not resolve is no channel at all.
  const ch = resolvedChannel(asyncOp.channel);
  const channelName = channelNameOf(ch);

  let target: ResolvedTarget;
  try {
    target = resolveTarget(doc, ch, args.context);
  } catch (e: unknown) {
    h.fireError(configOrSourceError(e, ""));
    return;
  }

  try {
    validateCell(doc, ch, asyncOp, target.protocol, args.source.bindingSpec, args.context);
  } catch (e: unknown) {
    h.fireError(new InvocationError(ERR_SOURCE_CONFIG_ERROR, errorMessage(e)));
    return;
  }

  // Context negotiation: challenge BEFORE any connection is opened. The
  // requirements derive from the selected artifact server (§9.5), including
  // when configuration replaces only its connection target.
  const required = requiredContext(asyncOp, target.securityServer, target.serverURL, args.context);
  if (required) {
    h.fireError(
      contextRequiredError(
        `operation "${opID}" requires credentials the context does not provide`,
        required,
      ),
    );
    return;
  }

  try {
    validateCredentialDestinations(asyncOp, target.securityServer, target.protocol, args.context);
  } catch (e: unknown) {
    h.fireError(new InvocationError(ERR_SOURCE_CONFIG_ERROR, errorMessage(e)));
    return;
  }

  // The address configuration point (ASYNC-P-04): the declared address with
  // every {name} expression expanded — an absent address or an unresolved
  // expression is a pre-dispatch refusal, never a guess.
  let address: string;
  let preparedInput: { ok: true; value: unknown } | undefined;
  try {
    const addrCfg = addressConfiguration(args.context);
    const needsPayload = channelNeedsOutgoingPayload(ch);
    if (needsPayload) {
      if (asyncOp.action !== "receive") throw new Error("subscription address uses a message runtime expression before any outgoing message exists");
      if (target.protocol !== "http" && target.protocol !== "https") {
        throw new Error("WebSocket publish address runtime expressions are not available before connection in revision 1");
      }
      if (noInputDeclared(args)) throw new Error("address runtime expression requires an outgoing message, but the operation declares no input");
      const first = await readFirstInput(h);
      if (!first.ok) throw new Error("address runtime expression requires an outgoing message, but invocation input is absent");
      await h.closeInput();
      preparedInput = first;
    }
    address = resolveAddress(ch, channelName, addrCfg, preparedInput?.value);
  } catch (e: unknown) {
    h.fireError(configOrSourceError(e, target.serverURL));
    return;
  }

  // The complementary perspective (ASYNC-P-02): `receive` means the
  // described application receives, so invoking PUBLISHES; `send` means it
  // sends, so invoking SUBSCRIBES.
  if (asyncOp.action !== "receive" && asyncOp.action !== "send") {
    h.fireError(
      new InvocationError(
        ERR_SOURCE_CONFIG_ERROR,
        `unknown action "${(asyncOp as { action: string }).action}"`,
      ),
    );
    return;
  }

  switch (target.protocol) {
    case "ws":
    case "wss": {
      // The websockets channel binding governs the upgrade request where it
      // speaks (§8): declared query and header values, supplied like
      // address parameters, with unsatisfied required declarations a
      // pre-dispatch refusal.
      let up: ReturnType<typeof resolveWSUpgrade>;
      try {
        const fields = protocolFieldValues(args.context);
        up = resolveWSUpgrade(ch, channelName, fields.webSocketQuery, fields.webSocketHeaders);
      } catch (e: unknown) {
        h.fireError(new InvocationError(ERR_SOURCE_CONFIG_ERROR, errorMessage(e)));
        return;
      }
      const dialAddress = mergeQuery(address, up.query);
      if (asyncOp.action === "receive") {
        await runWSPublish(wsPool, target, dialAddress, up.headers, doc, ch, asyncOp, args, h);
      } else {
        await runWSSubscribe(wsPool, target, dialAddress, up.headers, doc, ch, asyncOp, args, h);
      }
      return;
    }
    case "http":
    case "https":
      if (asyncOp.action === "receive") {
        await runUnaryPublish(target, address, doc, ch, asyncOp, args, h, preparedInput);
      } else {
        await runSSESubscribe(target, address, doc, ch, asyncOp, args, h);
      }
      return;
    default:
      // resolveTarget only yields bound protocols; defensive.
      h.fireError(
        new InvocationError(
          ERR_SOURCE_CONFIG_ERROR,
          `protocol "${target.protocol}" is not bound by the supported openbindings.asyncapi revisions (supported: http, https, ws, wss)`,
        ),
      );
  }
}

/** The operation's resolved channel object, or undefined when the channel
 *  `$ref` did not resolve (the dereferencer leaves dangling refs in place). */
function resolvedChannel(ch: AsyncAPIChannel | undefined): AsyncAPIChannel | undefined {
  if (!ch) return undefined;
  if (typeof (ch as unknown as Record<string, unknown>).$ref === "string") return undefined;
  return ch;
}

function validateCell(
  doc: AsyncAPIDocument,
  ch: AsyncAPIChannel | undefined,
  op: AsyncAPIOperation,
  protocol: string,
  bindingSpec: string,
  context?: Record<string, unknown>,
): void {
  const httpBinding = op.bindings?.http;
  if (httpBinding?.bindingVersion !== undefined && httpBinding.bindingVersion !== "0.3.0") {
    throw new Error(`HTTP binding version ${JSON.stringify(httpBinding.bindingVersion)} is outside revision 1's incorporated 0.3.0 envelope`);
  }
  const wsBinding = ch?.bindings?.ws;
  if (wsBinding?.bindingVersion !== undefined && wsBinding.bindingVersion !== "0.1.0") {
    throw new Error(`WebSockets binding version ${JSON.stringify(wsBinding.bindingVersion)} is outside revision 1's incorporated 0.1.0 envelope`);
  }

  if (protocol === "http" || protocol === "https") {
    if (op.action === "send") throw new Error("standalone HTTP send operations are excluded from revision 1");
    if (!httpBinding?.method?.trim()) throw new Error("HTTP receive operation has no artifact-declared HTTP method; POST is not inferred");
    const selected = selectedInputMessages(op, ch, context);
    validateMessageBindingVersion(selected[0]!);
    resolveInputCodec(doc, selected, context);
    if (!replyMessagesBindable(doc, op)) {
      throw new Error("an HTTP reply message uses carriage outside revision 1");
    }
    resolveHTTPQuery(op, protocolFieldValues(context).httpQuery);
    return;
  }

  if (op.action === "receive") {
    if (op.reply) throw new Error("reply-bearing WebSocket receive operations are excluded from revision 1");
    const selected = selectedInputMessages(op, ch, context);
    validateMessageBindingVersion(selected[0]!);
    resolveInputCodec(doc, selected, context);
    const messageType = contextConfiguration(context)["websocketMessageType"];
    if (messageType !== "text" && messageType !== "binary") {
      throw new Error("configuration.websocketMessageType must select text or binary for a WebSocket publish");
    }
  } else {
    if (op.reply && preservesSendReplies(bindingSpec)) {
      throw new Error("reply-bearing WebSocket send operations are excluded from revision 2");
    }
    // This validates non-empty output declarations, message-header
    // exclusions, declaration identity, and the decode point when absent.
    decodeContentType(doc, governingMessages(op, ch), context);
  }
}

function channelNeedsOutgoingPayload(ch: AsyncAPIChannel | undefined): boolean {
  return Object.values(ch?.parameters ?? {}).some((parameter) => typeof parameter.location === "string");
}

function validateCredentialDestinations(
  op: AsyncAPIOperation,
  server: AsyncAPIServer | undefined,
  protocol: string,
  context?: Record<string, unknown>,
): void {
  if (!context) return;
  const fields = protocolFieldValues(context);
  const wsQuery = new Set(Object.keys(fields.webSocketQuery ?? {}));
  const wsHeaders = new Set(Object.keys(fields.webSocketHeaders ?? {}).map((name) => name.toLowerCase()));
  const processorHeaders = new Set(protocol === "http" || protocol === "https"
    ? ["host", "content-length", "content-type"]
    : ["host", "connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol"]);
  const destinations = new Set<string>();
  for (const name of Object.keys(contextHeaders(context))) {
    if (processorHeaders.has(name.toLowerCase())) {
      throw new Error(`configured header ${JSON.stringify(name)} collides with a processor-owned transport field`);
    }
  }
  for (const { scheme, name } of resolveSecuritySchemes(op, server)) {
    let destination: string | undefined;
    let credential: string | undefined;
    if (scheme.type === "httpApiKey") {
      credential = contextApiKeyFor(context, name);
      if (credential && scheme.name && scheme.in) destination = `${scheme.in}:${scheme.in === "header" ? scheme.name.toLowerCase() : scheme.name}`;
    } else if (scheme.type === "http" && ["basic", "bearer"].includes((scheme.scheme ?? "").toLowerCase())) {
      credential = (scheme.scheme ?? "").toLowerCase() === "basic" ? (contextBasicAuth(context) ? "present" : undefined) : contextBearerToken(context);
      if (credential) destination = "header:authorization";
    } else if (scheme.type === "oauth2" || scheme.type === "openIdConnect" || scheme.type === "httpBearer") {
      credential = contextBearerToken(context) || contextString(context, "accessToken");
      if (credential) destination = "header:authorization";
    }
    if (!destination) continue;
    if (destinations.has(destination)) throw new Error(`two credentials target the same ${destination} destination`);
    destinations.add(destination);
    const [channel, rawName] = destination.split(":", 2) as [string, string];
    if (channel === "header" && processorHeaders.has(rawName)) throw new Error(`credential destination ${rawName} collides with a processor-owned transport field`);
    if (protocol === "ws" || protocol === "wss") {
      if (channel === "query" && wsQuery.has(rawName)) throw new Error(`credential query destination ${rawName} collides with a declared WebSocket protocol field`);
      if (channel === "header" && wsHeaders.has(rawName)) throw new Error(`credential header destination ${rawName} collides with a declared WebSocket protocol field`);
    }
  }
}

// Server and address resolution (the §9.2 configuration points) live in
// target.ts; protocol-bindings honoring in bindings.ts; governing
// content-type resolution in content.ts.

// ---------------------------------------------------------------------------
// Context requirements (CONTEXT_REQUIRED negotiation)
// ---------------------------------------------------------------------------

/** A security scheme paired with its addressable name (rule A). */
interface NamedSecurityScheme {
  scheme: AsyncAPISecurityScheme;
  name?: string;
}

/**
 * Reads the components.securitySchemes key a `$ref`-resolved scheme object
 * came from, off the {@link REF_NAME_TAG} field util.ts's
 * tagSecurityRefNames tagged onto the entry BEFORE the shared dereferencer
 * ran (rule A). Object identity cannot recover this: the shared
 * dereferencer (deref.ts) resolves an internal `$ref` by looking it up
 * against the ORIGINAL document it was given, not the clone it progressively
 * walks and returns, so a resolved scheme is never reference-equal to
 * anything reachable from the FINAL document — tagging is what survives that
 * gap (dereference's merge-copy path carries extra `$ref`-node keys onto the
 * resolved object). An inline scheme object (declared directly in
 * `security`, no `$ref`) was never tagged and gets no name — rule A: "an
 * inline scheme object with no addressable name emits no `name`."
 */
function nameForScheme(scheme: AsyncAPISecurityScheme): string | undefined {
  const tagged = (scheme as unknown as Record<string, unknown>)[REF_NAME_TAG];
  return typeof tagged === "string" ? tagged : undefined;
}

/** One declared security list, as resolved named schemes (after dereference,
 * security items are resolved scheme objects). */
function schemeList(raw: AsyncAPIOperation["security"]): NamedSecurityScheme[] {
  return (raw ?? []).filter(isSecurityScheme).map((scheme) => ({ scheme, name: nameForScheme(scheme) }));
}

/** The security list of the server whose declared security applies (§9.5)
 * — never some other server's declaration. */
function serverSecuritySchemes(server: AsyncAPIServer | undefined): NamedSecurityScheme[] {
  return schemeList(server?.security);
}

/** The operation's own security list. It never displaces the server's: the
 * two lists are conjunctive (ASYNC-P-07) — the server's security applies,
 * and the operation's applies in addition. */
function operationSecuritySchemes(asyncOp: AsyncAPIOperation): NamedSecurityScheme[] {
  return schemeList(asyncOp.security);
}

/**
 * The security schemes applicable to an operation, flattened for credential
 * placement: the targeted server's list then the operation's list, in
 * declaration order — both apply, the conjunctive reading (ASYNC-P-07) —
 * with a scheme declared on both levels placed once.
 */
function resolveSecuritySchemes(
  asyncOp: AsyncAPIOperation,
  server: AsyncAPIServer | undefined,
): NamedSecurityScheme[] {
  const result: NamedSecurityScheme[] = [];
  const seen = new Set<string>();
  for (const named of [...serverSecuritySchemes(server), ...operationSecuritySchemes(asyncOp)]) {
    const key = `${named.scheme.type}\x00${named.scheme.scheme ?? ""}\x00${named.name ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(named);
  }
  return result;
}

/**
 * Maps an AsyncAPI security scheme to a context requirement's type-specific
 * fields (name/description are layered on by schemeRequirement below). Every
 * scheme maps to SOMETHING: a recognized family, or — per the R2.c ruling —
 * a surfaced "auth.<T>" requirement (an http scheme with an unmapped
 * `scheme` value becomes "auth.http.<scheme>"; any other unmapped artifact
 * `type` becomes "auth.<type>" verbatim, e.g. "auth.scramSha256",
 * "auth.X509") so the alternative stays discoverable instead of being
 * silently dropped.
 */
function mapScheme(scheme: AsyncAPISecurityScheme, baseURL: string): ContextRequirement {
  switch (scheme.type) {
    case "http": {
      const s = (scheme.scheme ?? "").toLowerCase();
      if (s === "bearer") return { type: "auth.bearer" };
      if (s === "basic") return { type: "auth.basic" };
      return { type: s ? `auth.http.${s}` : "auth.http" };
    }
    case "httpBearer":
      return { type: "auth.bearer" };
    case "userPassword":
      return { type: "auth.basic" };
    case "apiKey":
    case "httpApiKey":
      return { type: "auth.apiKey" };
    case "oauth2":
      return oauth2Requirement(scheme, baseURL);
    default:
      return { type: `auth.${scheme.type}` };
  }
}

/**
 * Builds an `auth.oauth2` requirement carrying the flow's authorize/token
 * URLs, scopes, and `grantType` (rule B) under the binding-invoker
 * contract's convention field names. Selection mirrors the OpenAPI format's
 * oauth2Requirement EXACTLY: authorizationCode, then implicit, then whichever
 * of password/clientCredentials declares a `tokenUrl` (password checked
 * first) — a fixed priority, not declaration order. Relative URLs are
 * resolved against the server base. No flow means no grantType.
 */
function oauth2Requirement(scheme: AsyncAPISecurityScheme, baseURL: string): ContextRequirement {
  const req: ContextRequirement = { type: "auth.oauth2" };
  const flows = scheme.flows;
  const tokenOnlyFlow = [flows?.password, flows?.clientCredentials].find(
    (f): f is AsyncAPIOAuthFlow => !!f && typeof f.tokenUrl === "string",
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

/** Names the OAuth2 grant type for the flow oauth2Requirement selected, by identity. */
function grantTypeFor(flows: AsyncAPIOAuthFlows | undefined, flow: AsyncAPIOAuthFlow): string {
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

/** Wraps mapScheme with the requirement's name (rule A) and description. */
function schemeRequirement(
  scheme: AsyncAPISecurityScheme,
  baseURL: string,
  name: string | undefined,
): ContextRequirement {
  const req = mapScheme(scheme, baseURL);
  if (name) req.name = name;
  if (scheme.description) req.description = scheme.description;
  return req;
}

/**
 * Computes the context the binding requires for this operation, or null when
 * the provided context already satisfies it (or the doc declares nothing
 * checkable). The declaration semantics are AsyncAPI 3.0's, incorporated,
 * and they are CONJUNCTIVE (ASYNC-P-07): the targeted server's `security`
 * applies (`server` is resolveTarget's selected artifact server per §9.5,
 * including when configuration replaces only its connection target),
 * and the operation's `security`, when declared, applies IN ADDITION.
 * Within each declared list one entry suffices, so the challenge is the
 * cross product: each alternative pairs one server entry with one operation
 * entry (or is a single entry when only one list is declared).
 * Side-effect-free; shared by runBinding and prepareBinding.
 */
export function requiredContext(
  asyncOp: AsyncAPIOperation,
  server: AsyncAPIServer | undefined,
  serverURL: string,
  ctx?: Record<string, unknown>,
): ContextRequiredDetails | null {
  const serverReqs = serverSecuritySchemes(server).map(({ scheme, name }) =>
    schemeRequirement(scheme, serverURL, name),
  );
  const opReqs = operationSecuritySchemes(asyncOp).map(({ scheme, name }) =>
    schemeRequirement(scheme, serverURL, name),
  );

  const alternatives: ContextAlternative[] = [];
  if (serverReqs.length > 0 && opReqs.length > 0) {
    for (const s of serverReqs) {
      for (const o of opReqs) {
        // The same scheme declared on both levels is one requirement, not a
        // duplicated conjunct.
        const requirements =
          o.type === s.type && o.name === s.name ? [s] : [s, o];
        alternatives.push({ requirements });
      }
    }
  } else {
    for (const r of [...serverReqs, ...opReqs]) {
      alternatives.push({ requirements: [r] });
    }
  }
  if (alternatives.length === 0) return null;

  const details: ContextRequiredDetails = {
    target: serverURL,
    alternatives,
  };
  if (ctx && contextSatisfies(ctx, details)) return null;
  return details;
}

// ---------------------------------------------------------------------------
// Credential application
// ---------------------------------------------------------------------------

function applyCredentialsViaSchemes(
  headers: Headers,
  asyncOp: AsyncAPIOperation,
  server: AsyncAPIServer | undefined,
  ctx: Record<string, unknown>,
): { applied: boolean; queryParams?: Record<string, string> } {
  const named = resolveSecuritySchemes(asyncOp, server);
  if (!named.length) return { applied: false };

  let applied = false;
  let queryParams: Record<string, string> | undefined;

  for (const { scheme, name: schemeName } of named) {
    const schemeType = scheme.type;
    switch (schemeType) {
      case "apiKey":
      case "httpApiKey": {
        // Rule D: the requirement's addressable name (schemeName, the
        // components.securitySchemes key) resolves the credential — distinct
        // from scheme.name below, which is the WIRE placement name (header/
        // query/cookie), not the lookup key.
        const val = contextApiKeyFor(ctx, schemeName);
        if (!val) continue;
        const loc = scheme.in;
        const name = scheme.name;
        switch (loc) {
          case "header":
            headers.set(name ?? "Authorization", val);
            applied = true;
            break;
          case "query":
            if (name) {
              queryParams ??= {};
              queryParams[name] = val;
              applied = true;
            }
            break;
          case "cookie":
            if (name) {
              headers.append("Cookie", `${name}=${encodeURIComponent(val)}`);
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
      case "httpBearer": {
        const token = contextBearerToken(ctx);
        if (token) {
          headers.set("Authorization", `Bearer ${token}`);
          applied = true;
        }
        break;
      }
      case "oauth2": {
        const token = contextBearerToken(ctx) || contextString(ctx, "accessToken");
        if (token) {
          headers.set("Authorization", `Bearer ${token}`);
          applied = true;
        }
        break;
      }
      case "userPassword": {
        const basic = contextBasicAuth(ctx);
        if (basic) {
          const encoded = btoa(`${basic.username}:${basic.password}`);
          headers.set("Authorization", `Basic ${encoded}`);
          applied = true;
        }
        break;
      }
    }
  }

  return { applied, queryParams };
}

function applyContext(
  headers: Headers,
  asyncOp: AsyncAPIOperation,
  server: AsyncAPIServer | undefined,
  ctx?: Record<string, unknown>,
): Record<string, string> | undefined {
  let queryParams: Record<string, string> | undefined;

  if (ctx) {
    const result = applyCredentialsViaSchemes(headers, asyncOp, server, ctx);
    queryParams = result.queryParams;
    for (const [k, v] of Object.entries(contextHeaders(ctx))) {
      headers.set(k, v);
    }
    const cookies = contextCookies(ctx);
    const parts: string[] = [];
    for (const [k, v] of Object.entries(cookies)) {
      parts.push(`${k}=${encodeURIComponent(v)}`);
    }
    if (parts.length > 0) {
      headers.append("Cookie", parts.join("; "));
    }
  }

  return queryParams;
}

// ---------------------------------------------------------------------------
// Publish over HTTP (`receive` action): unary, artifact-declared method
// ---------------------------------------------------------------------------

async function runUnaryPublish(
  target: ResolvedTarget,
  address: string,
  doc: AsyncAPIDocument,
  ch: AsyncAPIChannel | undefined,
  asyncOp: AsyncAPIOperation,
  args: BindingInvocationArgs,
  h: Handle,
  preparedInput?: { ok: true; value: unknown },
): Promise<void> {
  // Unary: the one input IS the message payload (ASYNC-P-03). A publish
  // invocation requires an input value — this family defines no empty
  // message, so absence is a pre-dispatch refusal, never an empty-object
  // substitute. An operation-layer call for an operation declaring no input
  // is refused up front: callers of no-input operations never write, so
  // reading would park.
  if (noInputDeclared(args)) {
    h.fireError(
      new InvocationError(
        ERR_MISSING_INPUT,
        "publish invocation requires an input message (the input is the message; the operation declares no input)",
      ),
    );
    return;
  }

  // Input encoding follows the governing request-side declaration
  // (ASYNC-P-03); an excluded declared family refuses BEFORE dispatch.
  let codec: InputCodec;
  try {
    codec = resolveInputCodec(doc, selectedInputMessages(asyncOp, ch, args.context), args.context);
  } catch (e: unknown) {
    h.fireError(new InvocationError(ERR_SOURCE_CONFIG_ERROR, errorMessage(e)));
    return;
  }

  const first = preparedInput ?? await readFirstInput(h);
  if (!first.ok) {
    h.fireError(
      new InvocationError(ERR_MISSING_INPUT, "publish invocation requires an input message"),
    );
    return;
  }
  await h.closeInput();

  let body: string;
  try {
    body = encodeInput(codec, first.value);
  } catch (e: unknown) {
    h.fireError(new InvocationError(ERR_VALIDATION_FAILED, errorMessage(e)));
    return;
  }

  let url = joinURL(target.serverURL, address);

  const headers = new Headers();
  if (codec.contentType !== "") headers.set("Content-Type", codec.contentType);
  const fields = protocolFieldValues(args.context);
  let requestQuery: Record<string, string> | undefined;
  try {
    requestQuery = resolveHTTPQuery(asyncOp, fields.httpQuery);
  } catch (e: unknown) {
    h.fireError(new InvocationError(ERR_SOURCE_CONFIG_ERROR, errorMessage(e)));
    return;
  }
  if (requestQuery) url = appendQuery(url, requestQuery);
  const authQueryParams = applyContext(headers, asyncOp, target.securityServer, args.context);
  if (authQueryParams) {
    for (const name of Object.keys(authQueryParams)) {
      if (requestQuery?.[name] !== undefined) {
        h.fireError(new InvocationError(ERR_SOURCE_CONFIG_ERROR, `credential query destination ${JSON.stringify(name)} collides with an HTTP protocol field`));
        return;
      }
    }
    url = appendQuery(url, authQueryParams);
  }

  const doFetch = args.fetch ?? fetch;
  let resp: Response;
  try {
    // The request method is the required http operation binding's `method`
    // (§8, ASYNC-P-02); validateCell already refused its absence.
    resp = await doFetch(url, {
      method: requestMethod(asyncOp, ""),
      headers,
      body,
      signal: h.signal,
      redirect: "manual",
    });
  } catch (e: unknown) {
    if (h.signal.aborted) return;
    h.fireError(new InvocationError(ERR_CONNECT_FAILED, errorMessage(e)));
    return;
  }

  // Classification (§9.4, ASYNC-P-06): a unary publish succeeds IFF the final
  // status, after any redirects, is 2xx. Mirrors the SSE establishment path's
  // strict-2xx test in this same file — a 3xx final (304, or a Location-less
  // redirect fetch does not follow) is a publish the server plausibly did not
  // accept, never a success.
  if (resp.status < 200 || resp.status >= 300) {
    const errBody = await readErrorBody(resp);
    h.fireError(
      new InvocationError(
        httpErrorCode(resp.status),
        "Invocation completed unsuccessfully",
        undefined,
        { status: resp.status, body: errBody },
      ),
    );
    return;
  }

  h.setHeader(headersToMetadata(resp.headers));

  let respText: string;
  try {
    // The unary reply body is one delivery unit: the consumer-configurable
    // delivery-unit bound applies (args.maxDeliveryUnitBytes, default 10MB).
    respText = await readResponseText(resp, resolveDeliveryUnitLimit(args));
  } catch (e: unknown) {
    h.fireError(new InvocationError(ERR_RESPONSE_ERROR, errorMessage(e)));
    return;
  }

  if (respText.length === 0) {
    // An empty body (202/204 acknowledgments included) yields no output
    // value: an acknowledgment is not a message and emits no value (§8).
    // The rule is body-based, never status-based.
    h.closeOutput();
    return;
  }

  if (!asyncOp.reply) {
    // The artifact declares no result message. Do not promote an arbitrary
    // HTTP response body into the OpenBindings operation boundary.
    h.closeOutput();
    return;
  }

  let replyDecode: string;
  try {
    replyDecode = resolveReplyContentType(
      doc,
      asyncOp,
      resp.status,
      resp.headers.get("Content-Type") ?? "",
      args.context,
    );
  } catch (e: unknown) {
    h.fireError(new InvocationError(ERR_PROTOCOL, errorMessage(e)));
    return;
  }

  // Decode through the consultation seam — content-independent, per the
  // conventions record's recommended built-in defaults: the reply-side
  // governing declaration decides the lane (direction-correct decode,
  // ASYNC-P-05) — JSON for application/json and +json suffixes (a
  // declared-JSON payload that fails to parse is loud), text otherwise.
  // Never sniffed.
  let output: unknown;
  try {
    output = await decodeThroughHooks(
      args.hooks,
      siteFor(args, target.serverURL),
      { status: resp.status, body: respText, meta: headersToMetadata(resp.headers) },
      builtinDecodeFor(replyDecode),
    );
  } catch (e: unknown) {
    h.fireError(toInvocationError(e));
    return;
  }

  // Success provenance stamps (per the conventions record's recommended
  // built-in defaults): decode is spec/content-type (the governing declared
  // contentType decides the lane), hook when overridden; classify is
  // not-consulted (asyncapi runs no result classifier — the HTTP status
  // guard above is transport, not a format verdict).
  h.setTrailer(decodeTrailer(args.hooks, "spec/content-type"));
  await h.emitOutput(output);
  h.closeOutput();
}

// ---------------------------------------------------------------------------
// Subscribe over HTTP (`send` action): SSE
// ---------------------------------------------------------------------------

async function runSSESubscribe(
  target: ResolvedTarget,
  address: string,
  doc: AsyncAPIDocument,
  ch: AsyncAPIChannel | undefined,
  asyncOp: AsyncAPIOperation,
  args: BindingInvocationArgs,
  h: Handle,
): Promise<void> {
  // The described application sends; we subscribe. An SSE subscription
  // takes no input: input closes on entry, and a late write rejects
  // non-terminally at the handle (the refusal surface for supplied input).
  void h.closeInput();

  let url = joinURL(target.serverURL, address);
  const headers = new Headers({ Accept: "text/event-stream" });
  const authQueryParams = applyContext(headers, asyncOp, target.securityServer, args.context);
  if (authQueryParams) {
    const sep = url.includes("?") ? "&" : "?";
    url += sep + new URLSearchParams(authQueryParams).toString();
  }

  const doFetch = args.fetch ?? fetch;
  let resp: Response;
  try {
    // The subscription framing is this specification's own pin (§8): the
    // request is a GET unless the http operation binding declares otherwise
    // (ASYNC-P-02: bindings are authoritative where they speak).
    resp = await doFetch(url, {
      method: requestMethod(asyncOp, "GET"),
      headers,
      signal: h.signal,
    });
  } catch (e: unknown) {
    if (h.signal.aborted) return; // cancellation is already terminal
    h.fireError(new InvocationError(ERR_CONNECT_FAILED, errorMessage(e)));
    return;
  }

  // Establishment (§8, ASYNC-P-06): a 2xx response bearing the
  // text/event-stream content type, judged on the FINAL response after any
  // redirects (fetch followed them; resp is final). Anything else is a
  // failure — non-2xx classifies as the transport status does; a 2xx
  // without the pinned framing is a protocol error, never a silent
  // reclassification.
  if (resp.status < 200 || resp.status >= 300) {
    const body = await readErrorBody(resp);
    h.fireError(
      new InvocationError(
        httpErrorCode(resp.status),
        "Invocation completed unsuccessfully",
        undefined,
        { status: resp.status, body },
      ),
    );
    return;
  }
  const ct = resp.headers.get("Content-Type") ?? "";
  if (normalizeMediaType(ct) !== "text/event-stream") {
    h.fireError(
      new InvocationError(
        ERR_PROTOCOL,
        `SSE subscription establishment requires a text/event-stream response, got content type ${JSON.stringify(ct)} (openbindings.asyncapi §8)`,
      ),
    );
    return;
  }

  const invocationMeta = headersToMetadata(resp.headers);
  h.setHeader(invocationMeta);

  // One transport, one invocation: transport close COMPLETES the
  // subscription — reconnection (`retry`, `Last-Event-ID`) is excluded from
  // revision 1 (§8), so no reconnect is ever attempted here. Outputs decode
  // by the operation's own message declarations (direction-correct decode,
  // ASYNC-P-05).
  const decodeCT = decodeContentType(doc, governingMessages(asyncOp, ch));
  await streamSSE(
    resp,
    args,
    siteFor(args, target.serverURL),
    h,
    invocationMeta,
    builtinDecodeFor(decodeCT),
  );
}

// ---------------------------------------------------------------------------
// WebSocket upgrade material
// ---------------------------------------------------------------------------

/** One FNV-1a (32-bit) pass over `str`, seeded, returned as an unsigned int. */
function fnv1a(str: string, seed: number): number {
  let hash = seed;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The upgrade request a WebSocket dial for this operation would send: the
 * full dial URL (server + dial address, query-placed credentials applied),
 * the upgrade headers (credential placement via {@link applyContext} plus
 * the resolved ws-binding header values), and a fingerprint of exactly that
 * material.
 *
 * NO credential ever rides a message body or a first frame under this
 * specification (§9.5, ASYNC-P-07) — the upgrade request IS the
 * connection's credential identity, so the fingerprint hashes exactly the
 * upgrade material (mirrors the Go SDK's credentialDigest). A digest — not
 * the raw material — feeds the pool key, so credentials never sit in map
 * keys. Two invocations whose fingerprints differ must never share a
 * pooled connection (cross-tenant credential leak).
 *
 * Non-cryptographic by design: two 32-bit FNV-1a passes with distinct seeds
 * give a 64-bit digest, which is plenty for a pool-key partition function
 * (the realistic collision surface is auth material containing high-entropy
 * tokens, not an adversary crafting collisions). This avoids a
 * `globalThis.crypto.subtle` dependency, which is not guaranteed available
 * without a flag on this package's minimum supported Node (18).
 */
function wsUpgradeMaterial(
  target: ResolvedTarget,
  dialAddress: string,
  asyncOp: AsyncAPIOperation,
  wsHeaders: Record<string, string> | undefined,
  ctx?: Record<string, unknown>,
): { url: string; headers: Record<string, string>; fingerprint: string } {
  const headers = new Headers();
  const authQueryParams = applyContext(headers, asyncOp, target.securityServer, ctx);
  // The resolved ws-binding header values (§8) are set after credential
  // placement, mirroring the Go SDK's createConn.
  for (const [name, val] of Object.entries(wsHeaders ?? {})) {
    headers.set(name, val);
  }

  const url = new URL(joinURL(target.serverURL, dialAddress));
  if (authQueryParams) {
    for (const [k, v] of Object.entries(authQueryParams)) {
      url.searchParams.set(k, v);
    }
  }

  const headerRecord: Record<string, string> = {};
  const headerParts: string[] = [];
  headers.forEach((value, name) => {
    headerRecord[name] = value;
    headerParts.push(`h:${name}=${value}`);
  });
  headerParts.sort();
  const material = [...headerParts, `q:${url.search}`].join(" ");
  const a = fnv1a(material, 0x811c9dc5);
  const b = fnv1a(material, 0x9e3779b9);
  return {
    url: url.toString(),
    headers: headerRecord,
    fingerprint: a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0"),
  };
}

/** Operation-layer no-input convention: binding populated, no input schema. */
function noInputDeclared(args: BindingInvocationArgs): boolean {
  return args.binding !== undefined && args.inputSchema === undefined;
}

// ---------------------------------------------------------------------------
// Subscribe over WebSocket (`send` action): bidi-capable, on a pooled socket
// ---------------------------------------------------------------------------

/**
 * Backpressure bounds for the undelivered-frame buffer between the socket
 * and the output pump: whichever bound trips first fails the stream
 * (bounded-queue-fail-loud, per the asyncapi binding spec's WS
 * slow-consumer ruling — Redis client-output-buffer-limit, NATS
 * slow-consumer, and MQTT max_queued_messages are the pub/sub-ecosystem
 * precedent, and NATS pairs a count bound with a byte bound the same way).
 * The handle's bounded output buffer IS the backpressure contract for a
 * draining consumer; an unbounded second buffer here would defeat it for a
 * non-draining one, so overflow fails the stream and closes the socket
 * instead. Reference-package defaults, not spec-mandated numbers.
 *
 * `let`, not `const`: setBackpressureBoundsForTest lowers these for a test
 * instead of pushing the full frame count / byte volume through a real
 * socket. This module is never re-exported from index.ts, so the mutable
 * bindings are intra-package only, not part of the public API.
 */
let MAX_BUFFERED_FRAMES = 1024;
let MAX_BUFFERED_BYTES = 64 * 1024 * 1024; // 64 MiB

/**
 * Test-only seam: lowers the WS receive backpressure bounds so overflow
 * tests can trip them deterministically without pushing the full volume
 * through a real socket. Returns a restore function.
 */
export function setBackpressureBoundsForTest(frames: number, bytes: number): () => void {
  const prevFrames = MAX_BUFFERED_FRAMES;
  const prevBytes = MAX_BUFFERED_BYTES;
  MAX_BUFFERED_FRAMES = frames;
  MAX_BUFFERED_BYTES = bytes;
  return () => {
    MAX_BUFFERED_FRAMES = prevFrames;
    MAX_BUFFERED_BYTES = prevBytes;
  };
}

async function runWSSubscribe(
  pool: WSPool,
  target: ResolvedTarget,
  dialAddress: string,
  wsHeaders: Record<string, string> | undefined,
  doc: AsyncAPIDocument,
  ch: AsyncAPIChannel | undefined,
  asyncOp: AsyncAPIOperation,
  args: BindingInvocationArgs,
  h: Handle,
): Promise<void> {
  // This cell is server-streaming, not bidirectional: the selected send
  // operation defines only what the described application emits.
  await h.closeInput();
  // Outputs decode by the operation's own message declarations
  // (direction-correct decode, ASYNC-P-05); forwarded input frames use the
  // same governing declaration (§9.1). An excluded declared family refuses
  // only when an input frame actually arrives — a duplex subscription's
  // inputs are optional, and the exclusion belongs to the input lane.
  const wsContentType = decodeContentType(doc, governingMessages(asyncOp, ch), args.context);
  let codec: InputCodec | undefined;
  let codecErr: unknown;
  try {
    codec = resolveInputCodec(doc, selectedInputMessages(asyncOp, ch, args.context), args.context);
  } catch (e: unknown) {
    codecErr = e;
  }

  const material = wsUpgradeMaterial(target, dialAddress, asyncOp, wsHeaders, args.context);
  let pooled: PooledWS;
  try {
    pooled = await pool.acquire(target.serverURL, dialAddress, {
      buildURL: () => material.url,
      credentialKey: material.fingerprint,
      headers: material.headers,
      signal: h.signal,
    });
  } catch (e: unknown) {
    if (h.signal.aborted) return;
    h.fireError(new InvocationError(ERR_CONNECT_FAILED, errorMessage(e)));
    return;
  }

  // NO in-band auth: no credential ever rides a message body or a first
  // frame under this specification (§9.5, ASYNC-P-07) — credentials ride
  // the upgrade request. In-band auth conventions (a first-frame bearer
  // message) are consumer configuration riding this duplex cell as an
  // ordinary input frame, never a built-in.

  const frames: string[] = [];
  // Parallel to `frames`: the byte length of each still-buffered frame, so
  // the running bufferedBytes total can be decremented in the output pump
  // without re-encoding the frame just to measure it again.
  const frameByteLengths: number[] = [];
  let bufferedBytes = 0;
  let overflowed = false;
  let overflowMessage = "";
  let frameDecodeError: Error | undefined;
  let socketClosed = false;
  let socketError: Error | undefined;
  let wake: (() => void) | undefined;
  const notify = () => wake?.();
  const byteEncoder = new TextEncoder();

  // The delivery-unit bound for this subscription's frames (each frame is
  // one delivery unit). Enforcement point differs from Go BY PLATFORM
  // IDIOM, not behavior: nhooyr/coder websocket exposes SetReadLimit (a
  // pre-delivery connection-level read limit), while the browser/undici
  // WebSocket API has no read-limit seam, so the TS lane checks each
  // message's byte size POST-RECEIVE, before decode — same bound, same
  // ERR_STREAM_ERROR terminal. Per-subscription, so an oversized frame
  // never tears down the shared pooled socket under sibling subscriptions.
  const maxUnitBytes = resolveDeliveryUnitLimit(args);

  const removeMsg = pooled.onMessage((data, decodeError) => {
    if (overflowed || frameDecodeError) return;
    if (decodeError) {
      frameDecodeError = decodeError;
      notify();
      return;
    }
    const frameBytes = byteEncoder.encode(data).length;
    if (frameBytes > maxUnitBytes) {
      // Refuse loudly: mark terminal (the output pump drains what was
      // already buffered, then fails the stream) and drop this and every
      // subsequent frame.
      overflowed = true;
      overflowMessage = `WebSocket message exceeds ${maxUnitBytes} byte limit`;
      notify();
      return;
    }
    if (frames.length >= MAX_BUFFERED_FRAMES) {
      overflowed = true;
      overflowMessage = `backpressure overflow: more than ${MAX_BUFFERED_FRAMES} undelivered frames`;
    } else if (bufferedBytes + frameBytes > MAX_BUFFERED_BYTES) {
      overflowed = true;
      overflowMessage = `backpressure overflow: more than ${MAX_BUFFERED_BYTES} undelivered bytes`;
    }
    if (overflowed) {
      // The consumer is not draining; stop buffering for THIS subscription
      // (the guard above drops further frames) and let the output pump fail
      // the stream after draining what's already buffered. The socket stays
      // open — it is shared with any sibling subscriptions (the pool is
      // ref-counted), so a slow consumer must never tear it down under
      // them; this listener detaches when the pump's terminal returns
      // through the finally below. Mirrors Go's wsSubscription overflow.
      notify();
      return;
    }
    frames.push(data);
    frameByteLengths.push(frameBytes);
    bufferedBytes += frameBytes;
    notify();
  });
  const removeClose = pooled.onClose((err) => {
    socketClosed = true;
    socketError = err;
    notify();
  });
  const onAbort = () => notify();
  h.signal.addEventListener("abort", onAbort);

  // Socket -> outputs. Owns the terminal transition. Each frame is one
  // delivery unit decoded through the consultation seam by the governing
  // declared content type (status null — a WS frame has no completion
  // status; never fabricated). Convention envelopes ({error}/{data}
  // unwrapping) are consumer knowledge: a decode hook's job, never the
  // builtin's.
  const wsSite = siteFor(args, target.serverURL);
  const outputPump = async (): Promise<void> => {
    while (true) {
      // Drain-before-terminal: unconditionally, regardless of `overflowed`
      // — a synchronous flood of incoming messages can set `overflowed`
      // before this pump ever gets a turn, and every frame already
      // buffered by then must still reach the consumer before the
      // terminal error does (matches the decode-error and socket-closed
      // paths below, and the Go SDK's wsSubscription.next).
      while (frames.length > 0) {
        const frame = frames.shift()!;
        bufferedBytes -= frameByteLengths.shift()!;
        let out: unknown;
        try {
          out = await decodeThroughHooks(
            args.hooks,
            wsSite,
            { status: null, body: frame, meta: {} },
            builtinDecodeFor(wsContentType),
          );
        } catch (e: unknown) {
          // A decode error mid-stream is terminal; already-emitted
          // outputs stand (drain-before-terminal).
          h.fireError(toInvocationError(e));
          return;
        }
        // Throws if the invocation terminated while parked: stop emitting.
        await h.emitOutput(out);
      }
      if (overflowed) {
        h.fireError(new InvocationError(ERR_STREAM_ERROR, overflowMessage));
        return;
      }
      if (frameDecodeError) {
        h.fireError(new InvocationError(ERR_VALIDATION_FAILED, frameDecodeError.message));
        return;
      }
      if (h.signal.aborted) return;
      if (socketClosed) {
        if (socketError) {
          h.fireError(new InvocationError(ERR_STREAM_ERROR, socketError.message));
        } else {
          h.closeOutput();
        }
        return;
      }
      await new Promise<void>((r) => {
        wake = r;
      });
      wake = undefined;
    }
  };

  // Inputs -> socket: the duplex lane — caller-supplied input values forward
  // as frames, and closing input does NOT end the subscription (outputs keep
  // flowing). Frames encode per the same governing declaration as §9.1
  // (resolved above); an excluded declared family refuses only here, when
  // an input actually arrives.
  const inputPump = async (): Promise<void> => {
    try {
      for await (const msg of h.inputs()) {
        if (codecErr !== undefined || !codec) {
          h.fireError(new InvocationError(ERR_SOURCE_CONFIG_ERROR, errorMessage(codecErr)));
          return;
        }
        let frame: string;
        try {
          frame = encodeInput(codec, msg);
        } catch (e: unknown) {
          h.fireError(new InvocationError(ERR_VALIDATION_FAILED, errorMessage(e)));
          return;
        }
        pooled.send(frame);
      }
    } catch {
      // Invocation terminated; the output pump owns the terminal transition.
    }
  };

  try {
    await Promise.all([
      outputPump().catch((e: unknown) => {
        h.fireError(
          e instanceof InvocationError
            ? e
            : new InvocationError(ERR_STREAM_ERROR, errorMessage(e)),
        );
      }),
      inputPump(),
    ]);
  } catch (e: unknown) {
    h.fireError(
      e instanceof InvocationError
        ? e
        : new InvocationError(ERR_STREAM_ERROR, errorMessage(e)),
    );
  } finally {
    h.signal.removeEventListener("abort", onAbort);
    removeMsg();
    removeClose();
    pooled.release();
  }
}

// ---------------------------------------------------------------------------
// Publish over WebSocket (`receive` action): client-streaming, pooled socket
// ---------------------------------------------------------------------------

async function runWSPublish(
  pool: WSPool,
  target: ResolvedTarget,
  dialAddress: string,
  wsHeaders: Record<string, string> | undefined,
  doc: AsyncAPIDocument,
  ch: AsyncAPIChannel | undefined,
  asyncOp: AsyncAPIOperation,
  args: BindingInvocationArgs,
  h: Handle,
): Promise<void> {
  // A publish invocation requires input — the input IS the message
  // (ASYNC-P-03); this family defines no empty message. An operation-layer
  // call for an operation declaring no input is refused before dispatch
  // (callers of no-input operations never write, so reading would park).
  if (noInputDeclared(args)) {
    h.fireError(
      new InvocationError(
        ERR_MISSING_INPUT,
        "publish invocation requires an input message (the input is the message; the operation declares no input)",
      ),
    );
    return;
  }

  // Input encoding follows the governing request-side declaration
  // (ASYNC-P-03); an excluded declared family refuses BEFORE dispatch —
  // before any socket is dialed.
  let codec: InputCodec;
  try {
    codec = resolveInputCodec(doc, selectedInputMessages(asyncOp, ch, args.context), args.context);
  } catch (e: unknown) {
    h.fireError(new InvocationError(ERR_SOURCE_CONFIG_ERROR, errorMessage(e)));
    return;
  }

  const material = wsUpgradeMaterial(target, dialAddress, asyncOp, wsHeaders, args.context);
  let pooled: PooledWS;
  try {
    pooled = await pool.acquire(target.serverURL, dialAddress, {
      buildURL: () => material.url,
      credentialKey: material.fingerprint,
      headers: material.headers,
      signal: h.signal,
    });
  } catch (e: unknown) {
    if (h.signal.aborted) return;
    h.fireError(new InvocationError(ERR_CONNECT_FAILED, errorMessage(e)));
    return;
  }

  // A socket that dies mid-stream must fail the publish, not silently
  // swallow frames and then close as success. The terminal also rejects
  // any caller write parked on the input channel.
  const removeClose = pooled.onClose((err) => {
    h.fireError(
      new InvocationError(
        ERR_STREAM_ERROR,
        err ? `socket failed mid-publish: ${err.message}` : "socket closed mid-publish",
      ),
    );
  });

  try {
    // NO auth frame, ever: no credential rides a message body or a first
    // frame under this specification (§9.5, ASYNC-P-07) — credentials ride
    // the upgrade request.
    //
    // Every input is one frame, encoded per the governing declaration
    // (§9.1); the loop ends cleanly when the caller closes input, and
    // throws if the invocation terminates. `send` throws on a dead socket,
    // so no frame is ever silently dropped. Closing with zero messages sent
    // is the streaming face of the presence rule (ASYNC-P-03): nothing was
    // published, so the invocation fails loudly.
    let sent = 0;
    for await (const msg of h.inputs()) {
      let frame: string;
      try {
        frame = encodeInput(codec, msg);
      } catch (e: unknown) {
        h.fireError(new InvocationError(ERR_VALIDATION_FAILED, errorMessage(e)));
        return;
      }
      const messageType = contextConfiguration(args.context)["websocketMessageType"];
      pooled.send(messageType === "binary" ? new TextEncoder().encode(frame) : frame);
      sent++;
    }
    if (sent === 0) {
      h.fireError(
        new InvocationError(
          ERR_MISSING_INPUT,
          "publish invocation requires an input message (input closed with no messages sent)",
        ),
      );
      return;
    }
    h.closeOutput();
  } catch (e: unknown) {
    h.fireError(
      e instanceof InvocationError
        ? e
        : new InvocationError(ERR_STREAM_ERROR, errorMessage(e)),
    );
  } finally {
    removeClose();
    pooled.release();
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function readFirstInput(
  h: Handle,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  for await (const v of h.inputs()) {
    return { ok: true, value: v };
  }
  return { ok: false };
}

function appendQuery(url: string, values: Record<string, string>): string {
  const parsed = new URL(url);
  for (const [name, value] of Object.entries(values)) parsed.searchParams.append(name, value);
  return parsed.toString();
}

function headersToMetadata(headers: Headers): Metadata {
  const md: Metadata = {};
  headers.forEach((value, key) => {
    md[key] = [value];
  });
  return md;
}

async function readErrorBody(resp: Response): Promise<unknown> {
  // The raw capture, verbatim (details are diagnostics, never a decoded
  // value — no sniffing on the failure path either).
  try {
    const text = await readResponseText(resp, MAX_RESPONSE_BYTES);
    return text || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The consultation seam's format half
// ---------------------------------------------------------------------------

/**
 * Returns the builtin decoder for a governing declared content type: strict
 * JSON for application/json and +json suffixes (a declared-JSON payload
 * that fails to parse is loud), text otherwise; an empty body is a null
 * output. Content-independent — the declaration decides, never the bytes.
 */
export function builtinDecodeFor(contentType: string): OutputDecoder {
  const isJSON = isJSONContentType(contentType);
  return (_site: InvokeSite, raw: RawResult): unknown => {
    if (raw.body.length === 0) return null;
    if (isJSON) {
      try {
        return JSON.parse(raw.body);
      } catch (e: unknown) {
        throw new InvocationError(
          ERR_RESPONSE_ERROR,
          `message declares ${JSON.stringify(contentType)} but the payload is not valid JSON: ${errorMessage(e)}`,
        );
      }
    }
    if (!isWellFormedUnicode(raw.body)) {
      throw new InvocationError(
        ERR_RESPONSE_ERROR,
        `message declares ${JSON.stringify(contentType)} but the payload is not valid UTF-8`,
      );
    }
    return raw.body;
  };
}

/**
 * Completes the site for one dispatch with the format-known target (the
 * resolved server URL). A missing site (direct format-package call) gets a
 * minimal one so hook tables keyed on format/ref still match.
 */
function siteFor(args: BindingInvocationArgs, serverURL: string): InvokeSite {
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
  if (site.target === "") site.target = serverURL;
  return site;
}

/**
 * Builds the x-ob-decode stamp (and the fixed x-ob-classify not-consulted
 * stamp — asyncapi runs no classifier) for a successful message decode,
 * given the builtin decode provenance token, per the conventions record's
 * recommended built-in defaults.
 */
function decodeTrailer(hooks: InvokeHooks | null | undefined, builtinDecode: string): Metadata {
  const decode = hooks?.decodeDecidedBy() === "hook" ? "hook" : builtinDecode;
  return { "x-ob-decode": [decode], "x-ob-classify": ["not-consulted"] };
}

/** Converts a seam failure into the terminal InvocationError to surface. */
function toInvocationError(e: unknown): InvocationError {
  if (e instanceof InvocationError) return e;
  return new InvocationError(ERR_RESPONSE_ERROR, errorMessage(e));
}

async function readResponseText(resp: Response, maxBytes: number): Promise<string> {
  if (!resp.body) return resp.text();

  const reader = resp.body.getReader();
  // Preserve a leading BOM as U+FEFF rather than silently stripping source
  // bytes. JSON decoding then rejects it consistently with Go; the text lane
  // returns it as declared payload content.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const chunks: string[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Cancel the body stream before bailing; releasing the lock alone
        // leaves the response socket pinned on the remaining bytes (the
        // pattern openapi's readResponseBytes and this package's own sse.ts
        // already follow).
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

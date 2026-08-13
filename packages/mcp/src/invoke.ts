import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import {
  InvocationError,
  contextApiKey,
  contextBearerToken,
  contextBasicAuth,
  contextHeaders,
  contextCookies,
  contextRequiredError,
  contextConfiguration,
  compileExampleSchema,
  ERR_EXECUTION_FAILED,
  ERR_CANCELLED,
  ERR_CONNECT_FAILED,
  ERR_INVALID_REF,
  ERR_REF_NOT_FOUND,
  ERR_RESPONSE_ERROR,
  ERR_SOURCE_CONFIG_ERROR,
  ERR_SOURCE_LOAD_FAILED,
  ERR_VALIDATION_FAILED,
  type BindingHandle,
  type BindingInvocationArgs,
} from "@openbindings/sdk";
import { BINDING_SPEC, CLIENT_NAME, CLIENT_VERSION } from "./constants.js";
import { liveListing, parsePinnedListing, resolveRef, type Listing, type TargetKind } from "./listing.js";

/** Consumer-level knobs the invoker threads into each run (openbindings.mcp@1 §9.3). */
export interface RunOptions {
  /** Consumer-level value of the `solicit` configuration point; undefined declines. */
  solicitProgress?: boolean;
}

/**
 * Parse a ref like "tools/name", "resources/uri",
 * "resourceTemplates/uriTemplate", or "prompts/name". The four entities
 * mirror MCP's four listable collections (§7, R5); resources and
 * resourceTemplates are distinct namespaces, so a resource URI and a
 * byte-identical template string never collide.
 */
export function parseRef(ref: string): { entityType: string; name: string } {
  const idx = ref.indexOf("/");
  if (idx < 0 || idx === 0 || idx === ref.length - 1) {
    throw new Error(
      `MCP ref "${ref}" must be in the form tools/<name>, resources/<uri>, resourceTemplates/<uriTemplate>, or prompts/<name>`,
    );
  }
  const entityType = ref.slice(0, idx);
  const name = ref.slice(idx + 1);
  if (
    entityType !== "tools" &&
    entityType !== "resources" &&
    entityType !== "resourceTemplates" &&
    entityType !== "prompts"
  ) {
    throw new Error(
      `MCP ref "${ref}" has invalid entity type "${entityType}" (must be tools, resources, resourceTemplates, or prompts)`,
    );
  }
  return { entityType, name };
}

/** Reads the first input, or undefined when the input side closes empty. */
async function readFirst<T>(it: AsyncIterable<T>): Promise<T | undefined> {
  for await (const v of it) return v;
  return undefined;
}

/**
 * Reports whether s starts with http:// or https:// (Go SDK's IsHTTPURL
 * parity). A prefix check rather than `new URL()` validity: it must reject
 * a wrong-but-syntactically-valid scheme (ftp://, ws://) the same way it
 * rejects garbage, and it must do so before any URL parsing or network I/O.
 */
function isHTTPURL(s: string): boolean {
  return s.startsWith("http://") || s.startsWith("https://");
}

/**
 * Checks MCP-D-02's location requirement offline, without connecting:
 * `location` is REQUIRED — this family is service-addressed, so a
 * content-only source addresses nothing — and must be an absolute
 * http/https URI addressing a Streamable HTTP endpoint. Throws a plain
 * Error the caller classifies as ERR_SOURCE_CONFIG_ERROR.
 */
export function validateEndpoint(location: string | undefined): asserts location is string {
  if (!location) {
    throw new Error(
      "MCP source requires a location (endpoint URL): a content-only source addresses nothing (MCP-D-02)",
    );
  }
  if (!isHTTPURL(location)) {
    throw new Error(
      `MCP source location must be an absolute HTTP or HTTPS URL, got ${JSON.stringify(location)} (MCP-D-02)`,
    );
  }
}

/**
 * Maps a thrown error to an InvocationError. JSON-RPC application data may
 * cross as opaque failure data; HTTP-status errors use the generic abstract
 * execution-failure code;
 * anything else falls back to the phase's code (ERR_CONNECT_FAILED during
 * the initialize handshake, ERR_SOURCE_LOAD_FAILED during live listing,
 * ERR_EXECUTION_FAILED during dispatch).
 */
function mapError(
  e: unknown,
  signal: AbortSignal,
  fallback: string,
): InvocationError {
  if (e instanceof InvocationError) return e;
  if (signal.aborted) {
    return new InvocationError(ERR_CANCELLED);
  }
  if (e instanceof McpError) {
    const data = (e as McpError & { data?: unknown }).data;
    return data !== undefined
      ? new InvocationError(ERR_EXECUTION_FAILED, data)
      : new InvocationError(ERR_EXECUTION_FAILED);
  }
  if (e instanceof StreamableHTTPError && typeof e.code === "number" && e.code > 0) {
    return new InvocationError(ERR_EXECUTION_FAILED);
  }
  return new InvocationError(fallback);
}

/** Validates the transport credential placement before initialize side effects. */
function validateCredentialHeaders(
  args: BindingInvocationArgs,
  location: string,
): InvocationError | null {
  const context = args.context;
  if (contextApiKey(context) || contextBasicAuth(context)) {
    return contextRequiredError({
        target: location,
        alternatives: [{ requirements: [{
          type: "auth.apiKey",
          description: "supply the credential through an explicitly named HTTP header",
        }] }],
      });
  }

  const headers = contextHeaders(context);
  const reserved = new Set([
    "host",
    "content-length",
    "content-type",
    "accept",
    "origin",
    "mcp-protocol-version",
    "mcp-session-id",
    "last-event-id",
  ]);
  const seen = new Map<string, string>();
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (contextBearerToken(context) && lower === "authorization") {
      return new InvocationError(ERR_SOURCE_CONFIG_ERROR);
    }
    if (reserved.has(lower)) {
      return new InvocationError(ERR_SOURCE_CONFIG_ERROR);
    }
    const prior = seen.get(lower);
    if (prior !== undefined) {
      return new InvocationError(ERR_SOURCE_CONFIG_ERROR);
    }
    seen.set(lower, name);
  }

  if (Object.keys(contextCookies(context)).length > 0 && seen.has("cookie")) {
    return new InvocationError(ERR_SOURCE_CONFIG_ERROR);
  }
  return null;
}

function buildMCPHeaders(context: Record<string, unknown> | undefined): Record<string, string> {
  const headers = { ...contextHeaders(context) };
  const bearer = contextBearerToken(context);
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const cookies = contextCookies(context);
  const names = Object.keys(cookies).sort();
  if (names.length > 0) headers.Cookie = names.map((name) => `${name}=${cookies[name]}`).join("; ");
  return headers;
}

/**
 * Runs one MCP binding invocation against the handle. Pre-dispatch failures
 * (bad ref, missing or non-HTTP endpoint, invalid pin, non-object input,
 * unresolvable ref) fire BEFORE the entity request is dispatched
 * (openbindings.mcp@1 §7, §9.1); ref/location/pin/input-shape failures fire
 * before any network I/O at all. Each call opens a fresh MCP session
 * (Streamable HTTP), resolves the ref against the listing, dispatches the
 * entity call, emits outputs, and closes.
 */
export async function runMCPBinding(
  args: BindingInvocationArgs,
  inv: BindingHandle<unknown, unknown>,
  opts?: RunOptions,
): Promise<void> {
  // --- Pre-dispatch validation: no network I/O has happened yet. ---
  if (args.source.bindingSpec !== BINDING_SPEC) {
    inv.fireError(new InvocationError(ERR_SOURCE_CONFIG_ERROR));
    return;
  }
  let entityType: string;
  let name: string;
  try {
    ({ entityType, name } = parseRef(args.ref));
  } catch {
    inv.fireError(
      new InvocationError(ERR_INVALID_REF),
    );
    return;
  }

  let location: string;
  try {
    validateEndpoint(args.source.location);
    location = args.source.location;
  } catch {
    inv.fireError(
      new InvocationError(ERR_SOURCE_CONFIG_ERROR),
    );
    return;
  }

  // A pinned listing (source content) validates up front: an invalid pin is
  // refused loudly before input collection and before any network I/O
  // (MCP-D-01).
  let pin: Listing | undefined;
  if (args.source.content !== undefined) {
    try {
      pin = parsePinnedListing(args.source.content);
    } catch {
      inv.fireError(
        new InvocationError(ERR_SOURCE_LOAD_FAILED),
      );
      return;
    }
  }

  // --- Resolution before dispatch (§7, MCP-P-02). ---
  // With a pin, resolution is offline-checkable: it happens here, before
  // input collection and before any connection, and the list requests are
  // never consulted (§6 content primacy). Without a pin it needs the live
  // exhausted listing and happens right after the handshake — still before
  // dispatch.
  let kind: TargetKind | undefined;
  let applicationOutputSchema: unknown;
  if (pin) {
    try {
      kind = resolveRef(pin, entityType, name, args.source.bindingSpec);
      if (args.source.bindingSpec === BINDING_SPEC) applicationOutputSchema = pin.toolOutputSchemas?.[name];
    } catch (e: unknown) {
      inv.fireError(mapError(e, inv.signal, ERR_REF_NOT_FOUND));
      return;
    }
  }

  // --- Collect input from the handle (tools and prompts). ---
  // Tools and prompts take one named-arguments object. Resource input
  // handling waits for resolution below: a template takes one input (its
  // variables), a static resource none, and only the listing can say which
  // the ref names.
  //
  // No-input convention: when the operation layer drives an operation that
  // declares no input (binding set, inputSchema absent — e.g. a
  // zero-argument tool or prompt), close input on entry and dispatch with
  // the arguments member omitted rather than reading. A caller of a
  // no-input operation never writes nor closes, so an unconditional read
  // would park forever.
  const noInput = args.binding !== undefined && args.inputSchema === undefined;
  let toolArgs: Record<string, unknown> | undefined; // undefined means absent: the arguments member is omitted (§9.1)
  let promptArgs: Record<string, string> | undefined; // undefined means absent: the arguments member is omitted (§9.1)
  if (entityType !== "resources" && entityType !== "resourceTemplates") {
    if (noInput) {
      void inv.closeInput();
    } else {
      const first = await readFirst(inv.inputs());
      // Validate BEFORE closing input: a terminal validation error must
      // precede the observable input-close side effect (which resolves the
      // `inputClosed` promise conduit consumers await). On the validation
      // path, fireError itself closes the input side, keeping the terminal
      // and the input-close atomic. `undefined` means the input side closed
      // empty — absent means "never written", not "written as null", so a
      // written null is a supplied non-object and is refused (§9.1,
      // MCP-P-03).
      if (first !== undefined) {
        if (entityType === "tools") {
          if (first === null || typeof first !== "object" || Array.isArray(first)) {
            inv.fireError(
              new InvocationError(ERR_VALIDATION_FAILED),
            );
            return;
          }
          // Defensive shallow copy keeps the invoker contract ("never
          // mutate caller input") even when the third-party MCP SDK passes
          // args by reference.
          toolArgs = { ...(first as Record<string, unknown>) };
        } else {
          try {
            promptArgs = promptArguments(first);
          } catch (e: unknown) {
            inv.fireError(mapError(e, inv.signal, ERR_VALIDATION_FAILED));
            return;
          }
        }
      }
      void inv.closeInput();
    }
  }

  if (inv.signal.aborted) return; // already terminal via ERR_CANCELLED

  // --- Connect: the MCP initialize handshake is the first network I/O. ---
  const credentialError = validateCredentialHeaders(args, location);
  if (credentialError) {
    inv.fireError(credentialError);
    return;
  }
  const authHeaders = buildMCPHeaders(args.context);
  const baseFetch = args.fetch ?? globalThis.fetch;

  // Preserve MCP request semantics across redirects; native response evidence
  // remains inside the MCP transport below the OpenBindings bridge.
  const captureFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    // Streamable HTTP POST and GET have different MCP meanings. Ordinary
    // user-agent redirect behavior is therefore unsafe (notably 303 POST ->
    // GET); surface the response so the protocol layer classifies it.
    return await baseFetch(url, { ...init, redirect: "manual" });
  };

  // NAMED EXCLUSION (delivery-unit bound, 2026-07-20 ruling): response
  // reading is delegated to the official MCP SDK, whose transport exposes
  // no read-limit seam, so args.maxDeliveryUnitBytes is NOT enforced on
  // this lane — see "Response size" in this package's README.
  const transport = new StreamableHTTPClientTransport(new URL(location), {
    fetch: captureFetch,
    ...(Object.keys(authHeaders).length > 0 ? { requestInit: { headers: authHeaders } } : {}),
  });
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });

  try {
    await client.connect(transport, { signal: inv.signal });
  } catch (e: unknown) {
    inv.fireError(mapError(e, inv.signal, ERR_CONNECT_FAILED));
    return;
  }

  // The upstream SDK intentionally accepts several MCP revisions. This
  // binding specification has evaluated exactly one, so gate the negotiated
  // revision before any listing or entity request.
  if (transport.protocolVersion !== "2025-11-25") {
    inv.fireError(new InvocationError(ERR_SOURCE_LOAD_FAILED));
    try { await client.close(); } catch { /* ignore close errors */ }
    return;
  }

  try {
    // --- Live resolution (no pin): the capability-gated, pagination-
    // exhausted listing for the ref's entity family, then the same
    // byte-exact match the pin path ran above (MCP-P-02). The entity
    // request is never dispatched blind on the ref name.
    if (kind === undefined) {
      let listing: Listing;
      try {
        listing = await liveListing(client, entityType, inv.signal);
      } catch (e: unknown) {
        inv.fireError(mapError(e, inv.signal, ERR_SOURCE_LOAD_FAILED));
        return;
      }
      kind = resolveRef(listing, entityType, name, args.source.bindingSpec); // throws ERR_REF_NOT_FOUND
      if (args.source.bindingSpec === BINDING_SPEC) applicationOutputSchema = listing.toolOutputSchemas?.[name];
    }

    // --- Resource input (post-resolution: static vs template decides the
    // interaction shape, §8/§9.1). ---
    let targetURI = name;
    if (entityType === "resources" || entityType === "resourceTemplates") {
      if (kind === "staticResource") {
        // Close first, then inspect any already-accepted buffered value. This
        // keeps the no-input path non-blocking while making a supplied value
        // a terminal pre-entity-dispatch refusal instead of silently dropping
        // it. A later write is rejected by the closed input side.
        await inv.closeInput();
        for await (const _value of inv.inputs()) {
          throw new InvocationError(ERR_VALIDATION_FAILED);
        }
      } else {
        targetURI = await expandTemplateInput(inv, name, noInput);
      }
    }

    // --- Dispatch. ---
    switch (kind) {
      case "tool": {
        const solicit = args.source.bindingSpec === BINDING_SPEC
          ? false
          : resolveSolicit(args.context, opts?.solicitProgress);
        await runTool(client, name, toolArgs, solicit, args.source.bindingSpec, applicationOutputSchema, inv);
        break;
      }
      case "prompt":
        await runPrompt(client, name, promptArgs, inv);
        break;
      default: // static resource, or a template expanded to targetURI
        await runResource(client, targetURI, inv);
        break;
    }
  } catch (e: unknown) {
    inv.fireError(mapError(e, inv.signal, ERR_EXECUTION_FAILED));
  } finally {
    try { await client.close(); } catch { /* ignore close errors */ }
  }
}

/**
 * Consults the family's `solicit` configuration point in its defined order
 * (openbindings.mcp@1 §9.3): per-invocation context.configuration["solicit"]
 * → consumer-level MCPInvoker option → the default, NOT solicited. A
 * non-bool per-invocation value is a declined override and falls through.
 * The default is content-independent and keeps a binding's observable
 * stream realization-neutral: no progressToken rides the call, and the
 * output stream is the result value alone (§9.2).
 */
function resolveSolicit(bindCtx: Record<string, unknown> | undefined, consumer: boolean | undefined): boolean {
  const v = contextConfiguration(bindCtx)["solicit"];
  if (typeof v === "boolean") return v;
  if (consumer !== undefined) return consumer;
  return false;
}

/**
 * Maps a supplied prompt input value (§9.1, MCP-P-03): it MUST be a JSON
 * object, and MCP prompt arguments are string-typed, so every member value
 * MUST be a string — a non-object input or a non-string member is refused
 * loudly before prompts/get is dispatched, never coerced.
 */
function promptArguments(v: unknown): Record<string, string> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new InvocationError(ERR_VALIDATION_FAILED);
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "string") {
      throw new InvocationError(ERR_VALIDATION_FAILED);
    }
    out[k] = val;
  }
  return out;
}

/**
 * Reads and validates a resource template's input value and expands the
 * template per RFC 6570 (§9.1, MCP-P-03). The input, when supplied, is a
 * JSON object of the template's variables: every member value MUST be an
 * RFC 6570 string, string list, or string map and every member MUST name a
 * declared variable — each violation is
 * refused loudly before resources/read is dispatched. An absent input (or a
 * no-input operation) expands with all variables undefined, which follows
 * RFC 6570's undefined-value expansion.
 */
async function expandTemplateInput(
  inv: BindingHandle<unknown, unknown>,
  template: string,
  noInput: boolean,
): Promise<string> {
  let tmpl: UriTemplate;
  try {
    tmpl = new UriTemplate(template);
  } catch {
    throw new InvocationError(ERR_SOURCE_LOAD_FAILED);
  }

  let first: unknown;
  let supplied = false;
  if (noInput) {
    void inv.closeInput();
  } else {
    const v = await readFirst(inv.inputs());
    if (v !== undefined) {
      first = v;
      supplied = true;
    }
    void inv.closeInput();
  }

  const values: Record<string, string | string[] | Record<string, string>> = {};
  if (supplied) {
    if (first === null || typeof first !== "object" || Array.isArray(first)) {
      throw new InvocationError(ERR_VALIDATION_FAILED);
    }
    const declared = new Set(tmpl.variableNames);
    for (const [k, v] of Object.entries(first)) {
      if (!declared.has(k)) {
        throw new InvocationError(ERR_VALIDATION_FAILED);
      }
      const stringMap = v !== null
        && typeof v === "object"
        && !Array.isArray(v)
        && Object.values(v as Record<string, unknown>).every((item) => typeof item === "string");
      if (typeof v !== "string" && !(Array.isArray(v) && v.every((item) => typeof item === "string")) && !stringMap) {
        throw new InvocationError(ERR_VALIDATION_FAILED);
      }
      values[k] = v as string | string[] | Record<string, string>;
    }
  }

  try {
    return expandRFC6570(template, values);
  } catch {
    throw new InvocationError(ERR_VALIDATION_FAILED);
  }
}

/**
 * RFC 6570 expansion for the string and list value domain exposed by this
 * binding. The upstream MCP helper currently joins an exploded query list
 * with a comma; RFC 6570 requires a repeated name (`?tag=a&tag=b`). Keeping
 * this small expansion point here avoids narrowing the artifact's legal
 * value domain to the helper's behavior.
 */
function expandRFC6570(
  template: string,
  values: Record<string, string | string[] | Record<string, string>>,
): string {
  return template.replace(/\{([+#./;?&]?)([^}]+)\}/g, (_whole, operator: string, body: string) => {
    const options = operatorOptions(operator);
    const pieces: string[] = [];
    for (const rawSpec of body.split(",")) {
      const exploded = rawSpec.endsWith("*");
      const withoutStar = exploded ? rawSpec.slice(0, -1) : rawSpec;
      const prefixIndex = withoutStar.indexOf(":");
      const name = prefixIndex >= 0 ? withoutStar.slice(0, prefixIndex) : withoutStar;
      const prefixLength = prefixIndex >= 0 ? Number(withoutStar.slice(prefixIndex + 1)) : undefined;
      const value = values[name];
      if (value === undefined) continue;
      const encodedName = encodeURIComponent(name);
      if (Array.isArray(value)) {
        const encoded = value.map((item) => encodeTemplateValue(item, options.allowReserved));
        if (exploded) {
          if (options.named) {
            for (const item of encoded) pieces.push(`${encodedName}=${item}`);
          } else {
            pieces.push(...encoded);
          }
        } else {
          const joined = encoded.join(",");
          pieces.push(options.named ? `${encodedName}=${joined}` : joined);
        }
      } else if (typeof value === "object") {
        const entries = Object.keys(value).sort().map((key) => [
          encodeTemplateValue(key, options.allowReserved),
          encodeTemplateValue(value[key]!, options.allowReserved),
        ] as const);
        if (exploded) {
          for (const [key, item] of entries) pieces.push(`${key}=${item}`);
        } else {
          const joined = entries.flatMap(([key, item]) => [key, item]).join(",");
          pieces.push(options.named ? `${encodedName}=${joined}` : joined);
        }
      } else {
        const selected = prefixLength === undefined ? value : [...value].slice(0, prefixLength).join("");
        const encoded = encodeTemplateValue(selected, options.allowReserved);
        pieces.push(options.named ? `${encodedName}=${encoded}` : encoded);
      }
    }
    return pieces.length === 0 ? "" : `${options.prefix}${pieces.join(options.separator)}`;
  });
}

function operatorOptions(operator: string): {
  prefix: string;
  separator: string;
  named: boolean;
  allowReserved: boolean;
} {
  switch (operator) {
    case "+": return { prefix: "", separator: ",", named: false, allowReserved: true };
    case "#": return { prefix: "#", separator: ",", named: false, allowReserved: true };
    case ".": return { prefix: ".", separator: ".", named: false, allowReserved: false };
    case "/": return { prefix: "/", separator: "/", named: false, allowReserved: false };
    case ";": return { prefix: ";", separator: ";", named: true, allowReserved: false };
    case "?": return { prefix: "?", separator: "&", named: true, allowReserved: false };
    case "&": return { prefix: "&", separator: "&", named: true, allowReserved: false };
    default: return { prefix: "", separator: ",", named: false, allowReserved: false };
  }
}

function encodeTemplateValue(value: string, allowReserved: boolean): string {
  const encoded = encodeURIComponent(value);
  if (!allowReserved) return encoded;
  return encoded.replace(/%(3A|2F|3F|23|5B|5D|40|21|24|26|27|28|29|2A|2B|2C|3B|3D)/gi, (match) =>
    String.fromCharCode(Number.parseInt(match.slice(1), 16)),
  );
}

/**
 * Invoke a tool call. When progress is solicited (§9.3's `solicit` point —
 * default off), correlated progress notifications stream as outputs ahead
 * of the final result; the result is always last (§9.2, MCP-P-04).
 */
async function runTool(
  client: Client,
  toolName: string,
  toolArgs: Record<string, unknown> | undefined,
  solicit: boolean,
  bindingSpec: string,
  applicationOutputSchema: unknown,
  inv: BindingHandle<unknown, unknown>,
): Promise<void> {
  // A supplied input maps whole and verbatim; an absent input omits the
  // arguments member ENTIRELY (§9.1) — never arguments: {}. The TS MCP SDK
  // passes params through verbatim (unlike go-mcp, which injects an empty
  // object the Go side strips at the transport), so omission here is
  // omission on the wire.
  const params: { name: string; arguments?: Record<string, unknown> } = { name: toolName };
  if (toolArgs !== undefined) params.arguments = toolArgs;

  if (!solicit) {
    // Solicitation off (the default): no progressToken rides the call and
    // the stream is exactly the result value (§9.2, MCP-P-05). The SDK
    // attaches _meta.progressToken only when an onprogress handler is
    // registered, so not registering one IS the wire-level off switch.
    const result = await client.callTool(params, undefined, { signal: inv.signal });
    await emitToolResult(result, toolName, bindingSpec, applicationOutputSchema, inv);
    return;
  }

  // Progress callbacks are synchronous; chain the emits so they stay
  // ordered and observe emitOutput's backpressure without a side buffer.
  // Once an emit fails the invocation is terminal: the terminated flag
  // makes every queued and subsequent link a no-op. The SDK hands the
  // handler the notification's params object with progressToken removed
  // (a rest spread over the raw JSON), which is exactly §9.2's
  // presence-preserving progress value: an explicit total: 0 survives, an
  // absent total stays absent — no wire tee is needed, unlike Go, whose
  // typed MCP structs collapse an explicit zero into absence.
  let progressChain: Promise<void> = Promise.resolve();
  let progressTerminated = false;
  let resultArrived = false;

  const result = await client.callTool(
    params,
    undefined,
    {
      signal: inv.signal,
      onprogress: (progress) => {
        // A correlated notification observed after the result is discarded
        // — §9.2's defined disposal: the result value terminates the stream
        // (MCP-P-04).
        if (resultArrived) return;
        progressChain = progressChain
          .then(() => {
            if (progressTerminated) return;
            return inv.emitOutput(progress);
          })
          .catch(() => {
            progressTerminated = true; // invocation terminated; stop emitting
          });
      },
    },
  );
  // Every pre-result notification has already appended its emit to the
  // chain (the transport delivers in order and this flag flips before any
  // further handler can run); anything correlated that arrives from here
  // on is late and is discarded above.
  resultArrived = true;
  await progressChain;

  await emitToolResult(result, toolName, bindingSpec, applicationOutputSchema, inv);
}

/**
 * Classifies and emits a completed tools/call result: an isError result is
 * a failure outcome whatever its content (§9.3, MCP-P-06); every other
 * completed result decodes per §9.2 and terminates the stream.
 */
async function emitToolResult(
  result: Awaited<ReturnType<Client["callTool"]>>,
  toolName: string,
  bindingSpec: string,
  applicationOutputSchema: unknown,
  inv: BindingHandle<unknown, unknown>,
): Promise<void> {
  if (result.isError) {
    // Application-level tool failure (CallToolResult.isError). The server
    // replied normally; classification is protocol-native (§9.3). Its
    // structuredContent member, when present, is the application-authored
    // failure value and crosses unchanged as abstract error data.
    throw Object.hasOwn(result, "structuredContent")
      ? new InvocationError(ERR_EXECUTION_FAILED, result.structuredContent)
      : new InvocationError(ERR_EXECUTION_FAILED);
  }

  let output: unknown = result;
  if (bindingSpec === BINDING_SPEC) {
    if (result.structuredContent === undefined) {
      throw new InvocationError(ERR_RESPONSE_ERROR);
    }
    const validation = compileExampleSchema(applicationOutputSchema, undefined).validate(result.structuredContent);
    if (!validation.valid) {
      throw new InvocationError(ERR_RESPONSE_ERROR);
    }
    output = result.structuredContent;
  }
  await inv.emitOutput(output);
  inv.closeOutput();
}

/**
 * Read an MCP resource. The output value is ALWAYS the array of decoded
 * contents items, in order (§9.3, MCP-P-05) — uniformly, so the value's
 * shape never depends on how many items the server returned: contents: []
 * yields [], and authors who want a bare single value declare an
 * outputTransform. Each item decodes by protocol structure FIRST: a blob
 * item passes as its Base64 string as MCP carries it, whatever mimeType it
 * declares; a text item decodes by its DECLARED mimeType, exactly the HTTP
 * header rule — json/+json parses strictly (a parse failure is a loud
 * error, never a silent fall-through), anything else is text, and the
 * payload's shape never picks the lane.
 */
async function runResource(
  client: Client,
  uri: string,
  inv: BindingHandle<unknown, unknown>,
): Promise<void> {
  const result = await client.readResource({ uri }, { signal: inv.signal });

  await inv.emitOutput(result);
  inv.closeOutput();
}

/** Get an MCP prompt. */
async function runPrompt(
  client: Client,
  promptName: string,
  promptArgs: Record<string, string> | undefined,
  inv: BindingHandle<unknown, unknown>,
): Promise<void> {
  // An absent input omits the arguments member entirely (§9.1); a supplied
  // one was validated string-typed before dispatch (MCP-P-03).
  const params: { name: string; arguments?: Record<string, string> } = { name: promptName };
  if (promptArgs !== undefined) params.arguments = promptArgs;

  const result = await client.getPrompt(params, { signal: inv.signal });

  await inv.emitOutput(result);
  inv.closeOutput();
}

/**
 * Parse MCP content array into a usable value. Reached only for content
 * shapes runTool's single-text-string fast path doesn't cover (multiple
 * items, non-text items, or a malformed single "text" item whose text
 * field isn't a string) -- exported for direct unit coverage of that edge.
 *
 * De-sniff ruling: text is never JSON-parsed by shape, including the
 * single-item case. There used to be a "single text content: try JSON
 * parse" branch here; it contradicted the ruling and is gone. A single
 * text item now falls into the allText join below, same as any other
 * all-text array, and comes out verbatim.
 */
export function parseContent(content: unknown): unknown {
  if (!Array.isArray(content) || content.length === 0) return content;

  // MCP-P-05 / §9.3: a single text block decodes to that text, verbatim as a
  // string (runTool's fast path handles the live single-text-string case;
  // this keeps parseContent consistent for a direct call and matches the Go
  // SDK's extractContent).
  if (content.length === 1 && (content[0] as { type?: string }).type === "text") {
    return (content[0] as { text?: string }).text ?? "";
  }

  // ANY OTHER content shape — two or more text blocks included — passes
  // through as the content array, verbatim in MCP's block shapes. Never a
  // "\n"-joined string with an invented separator.
  return content;
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import {
  InvocationError,
  buildAuthHeaders,
  contextConfiguration,
  httpErrorCode,
  httpErrorEffects,
  ERR_CANCELLED,
  ERR_CONNECT_FAILED,
  ERR_EXECUTION_FAILED,
  ERR_INVALID_REF,
  ERR_REF_NOT_FOUND,
  ERR_SOURCE_CONFIG_ERROR,
  ERR_SOURCE_LOAD_FAILED,
  ERR_VALIDATION_FAILED,
  type BindingHandle,
  type BindingInvocationArgs,
  type Metadata,
  decodeThroughHooks,
  type InvokeSite,
  type InvokeHooks,
  type RawResult,
} from "@openbindings/sdk";
import { CLIENT_NAME, CLIENT_VERSION } from "./constants.js";
import { liveListing, parsePinnedListing, resolveRef, type Listing, type TargetKind } from "./listing.js";

/** Consumer-level knobs the invoker threads into each run (openbindings.mcp@1 §9.3). */
export interface RunOptions {
  /** Consumer-level value of the `solicit` configuration point; undefined declines. */
  solicitProgress?: boolean;
}

/** Parse a ref like "tools/name", "resources/uri", or "prompts/name". */
export function parseRef(ref: string): { entityType: string; name: string } {
  const idx = ref.indexOf("/");
  if (idx < 0 || idx === 0 || idx === ref.length - 1) {
    throw new Error(`MCP ref "${ref}" must be in the form tools/<name>, resources/<uri>, or prompts/<name>`);
  }
  const entityType = ref.slice(0, idx);
  const name = ref.slice(idx + 1);
  if (entityType !== "tools" && entityType !== "resources" && entityType !== "prompts") {
    throw new Error(`MCP ref "${ref}" has invalid entity type "${entityType}" (must be tools, resources, or prompts)`);
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

/** Names a JSON value's kind for refusal messages (the Go side prints %T). */
function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * Maps a thrown error to an InvocationError. JSON-RPC errors carry the MCP
 * error code/data in details; HTTP-status errors map via httpErrorCode;
 * anything else falls back to the phase's code (ERR_CONNECT_FAILED during
 * the initialize handshake, ERR_SOURCE_LOAD_FAILED during live listing,
 * ERR_EXECUTION_FAILED during dispatch).
 */
function mapError(e: unknown, signal: AbortSignal, fallback: string): InvocationError {
  if (e instanceof InvocationError) return e;
  if (signal.aborted) {
    return new InvocationError(ERR_CANCELLED, "invocation cancelled");
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof McpError) {
    return new InvocationError(ERR_EXECUTION_FAILED, msg, { code: e.code, data: e.data });
  }
  if (e instanceof StreamableHTTPError && typeof e.code === "number" && e.code > 0) {
    return new InvocationError(httpErrorCode(e.code), msg, { status: e.code }, httpErrorEffects(e.code));
  }
  return new InvocationError(fallback, msg);
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
  let entityType: string;
  let name: string;
  try {
    ({ entityType, name } = parseRef(args.ref));
  } catch (e: unknown) {
    inv.fireError(
      new InvocationError(ERR_INVALID_REF, e instanceof Error ? e.message : String(e)),
    );
    return;
  }

  let location: string;
  try {
    validateEndpoint(args.source.location);
    location = args.source.location;
  } catch (e: unknown) {
    inv.fireError(
      new InvocationError(ERR_SOURCE_CONFIG_ERROR, e instanceof Error ? e.message : String(e)),
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
    } catch (e: unknown) {
      inv.fireError(
        new InvocationError(ERR_SOURCE_LOAD_FAILED, e instanceof Error ? e.message : String(e)),
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
  if (pin) {
    try {
      kind = resolveRef(pin, entityType, name);
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
  if (entityType !== "resources") {
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
              new InvocationError(
                ERR_VALIDATION_FAILED,
                `MCP tool input must be an object when supplied, got ${typeName(first)}`,
              ),
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
  const authHeaders = buildAuthHeaders(args.context);
  const baseFetch = args.fetch ?? globalThis.fetch;

  // Capture HTTP response headers from POSTs (initialize, the list calls,
  // then the entity call) so the latest capture at first-emit time is the
  // call's response.
  let responseHeaders: Metadata = {};
  const captureFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const response = await baseFetch(url, init);
    if (init?.method === "POST") {
      const md: Metadata = {};
      response.headers.forEach((value, key) => {
        (md[key] ??= []).push(value);
      });
      responseHeaders = md;
    }
    return response;
  };

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

  // setHeader must precede the first emit and may only happen once.
  let headerSet = false;
  const setHeaderOnce = (): void => {
    if (headerSet) return;
    headerSet = true;
    inv.setHeader(responseHeaders);
  };

  const site = siteFor(args, location);
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
      kind = resolveRef(listing, entityType, name); // throws ERR_REF_NOT_FOUND
    }

    // --- Resource input (post-resolution: static vs template decides the
    // interaction shape, §8/§9.1). ---
    let targetURI = name;
    if (entityType === "resources") {
      if (kind === "staticResource") {
        // Static resources take no input (§9.1): the input side closes
        // without reading. A caller that then supplies a value gets a loud
        // ERR_INPUT_CLOSED on its write — the refusal surface the handle
        // model gives a value this binding may never read.
        void inv.closeInput();
      } else {
        targetURI = await expandTemplateInput(inv, name, noInput);
      }
    }

    // --- Dispatch. ---
    switch (kind) {
      case "tool": {
        const solicit = resolveSolicit(args.context, opts?.solicitProgress);
        await runTool(client, name, toolArgs, solicit, inv, setHeaderOnce, site, args.hooks);
        break;
      }
      case "prompt":
        await runPrompt(client, name, promptArgs, inv, setHeaderOnce);
        break;
      default: // static resource, or a template expanded to targetURI
        await runResource(client, targetURI, inv, setHeaderOnce, site, args.hooks);
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
    throw new InvocationError(
      ERR_VALIDATION_FAILED,
      `MCP prompt input must be an object when supplied, got ${typeName(v)}`,
    );
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "string") {
      throw new InvocationError(
        ERR_VALIDATION_FAILED,
        `MCP prompt argument ${JSON.stringify(k)} must be a string, got ${typeName(val)} (prompt arguments are string-typed and are never coerced)`,
      );
    }
    out[k] = val;
  }
  return out;
}

/**
 * Reads and validates a resource template's input value and expands the
 * template per RFC 6570 (§9.1, MCP-P-03). The input, when supplied, is a
 * JSON object of the template's variables: every member value MUST be a
 * string and every member MUST name a declared variable — each violation is
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
  } catch (e: unknown) {
    throw new InvocationError(
      ERR_SOURCE_LOAD_FAILED,
      `MCP listing declares resource template ${JSON.stringify(template)}, which is not a valid RFC 6570 URI template: ${e instanceof Error ? e.message : String(e)}`,
    );
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

  const values: Record<string, string> = {};
  if (supplied) {
    if (first === null || typeof first !== "object" || Array.isArray(first)) {
      throw new InvocationError(
        ERR_VALIDATION_FAILED,
        `MCP resource-template input must be an object of template variables when supplied, got ${typeName(first)}`,
      );
    }
    const declared = new Set(tmpl.variableNames);
    for (const [k, v] of Object.entries(first)) {
      if (!declared.has(k)) {
        throw new InvocationError(
          ERR_VALIDATION_FAILED,
          `MCP resource-template input names variable ${JSON.stringify(k)}, which template ${JSON.stringify(template)} does not declare`,
        );
      }
      if (typeof v !== "string") {
        throw new InvocationError(
          ERR_VALIDATION_FAILED,
          `MCP resource-template variable ${JSON.stringify(k)} must be a string, got ${typeName(v)} (template variables are never coerced)`,
        );
      }
      values[k] = v;
    }
  }

  try {
    return tmpl.expand(values);
  } catch (e: unknown) {
    throw new InvocationError(
      ERR_VALIDATION_FAILED,
      `RFC 6570 expansion of template ${JSON.stringify(template)} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
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
  inv: BindingHandle<unknown, unknown>,
  setHeaderOnce: () => void,
  site: InvokeSite,
  hooks: InvokeHooks | null | undefined,
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
    await emitToolResult(result, toolName, inv, setHeaderOnce, site, hooks);
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
            setHeaderOnce();
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

  await emitToolResult(result, toolName, inv, setHeaderOnce, site, hooks);
}

/**
 * Classifies and emits a completed tools/call result: an isError result is
 * a failure outcome whatever its content (§9.4, MCP-P-06); every other
 * completed result decodes per §9.3 and terminates the stream.
 */
async function emitToolResult(
  result: Awaited<ReturnType<Client["callTool"]>>,
  toolName: string,
  inv: BindingHandle<unknown, unknown>,
  setHeaderOnce: () => void,
  site: InvokeSite,
  hooks: InvokeHooks | null | undefined,
): Promise<void> {
  if (result.isError) {
    // Application-level tool failure (CallToolResult.isError). The server
    // replied normally; classification is protocol-native (§9.4).
    const msg = extractContent(result.content);
    throw new InvocationError(
      ERR_EXECUTION_FAILED,
      msg || `MCP tool ${JSON.stringify(toolName)} reported an error`,
    );
  }

  // structuredContent is MCP's declared structured lane (2025-11-25:
  // servers MUST conform it to outputSchema) and wins outright. A single
  // text content is a STRING by the content-independent builtin —
  // JSON-in-text is the spec's backwards-compatibility shadow of
  // structuredContent, and parsing it is a consumer choice made through
  // the decode seam, never a payload sniff.
  let output: unknown;
  let decodeStamp: string;
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    output = result.structuredContent;
    decodeStamp = "structuredContent";
  } else if (
    Array.isArray(result.content) &&
    result.content.length === 1 &&
    result.content[0].type === "text" &&
    typeof result.content[0].text === "string"
  ) {
    output = await decodeThroughHooks(
      hooks,
      site,
      { status: null, body: result.content[0].text, meta: {} },
      builtinTextDecode,
    );
    decodeStamp = decodeStampFor(hooks, "text");
  } else {
    output = parseContent(result.content);
    decodeStamp = "content";
  }
  setHeaderOnce();
  inv.setTrailer({ "x-ob-decode": [decodeStamp], "x-ob-classify": ["protocol/isError"] });
  await inv.emitOutput(output);
  inv.closeOutput();
}

/**
 * The MCP text builtin: the value is the text, verbatim.
 * Content-independent per the specification's decode point (§9.3);
 * JSON-in-text consumers opt in with a decode hook.
 */
function builtinTextDecode(_site: InvokeSite, raw: RawResult): unknown {
  return typeof raw.body === "string" ? raw.body : String(raw.body);
}

/** Names the decode lane for the x-ob-decode stamp ("hook" when a hook decided). */
function decodeStampFor(hooks: InvokeHooks | null | undefined, builtin: string): string {
  return hooks?.decodeDecidedBy?.() === "hook" ? "hook" : builtin;
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
  setHeaderOnce: () => void,
  site: InvokeSite,
  hooks: InvokeHooks | null | undefined,
): Promise<void> {
  const result = await client.readResource({ uri }, { signal: inv.signal });

  const items: unknown[] = [];
  for (const c of result.contents ?? []) {
    if (c == null) continue;
    const blob = (c as { blob?: unknown }).blob;
    if (typeof blob === "string") {
      // Structural: the wire item carried a blob member — its Base64
      // string passes as MCP carries it, before any mimeType consideration.
      items.push(blob);
      continue;
    }
    const text = typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "";
    const mimeType =
      typeof (c as { mimeType?: unknown }).mimeType === "string" ? (c as { mimeType: string }).mimeType : "";
    items.push(
      await decodeThroughHooks(hooks, site, { status: null, body: text, meta: {} }, builtinMimeDecode(mimeType)),
    );
  }

  setHeaderOnce();
  inv.setTrailer({ "x-ob-decode": [decodeStampFor(hooks, "contents/declared")] });
  await inv.emitOutput(items);
  inv.closeOutput();
}

/**
 * The resource builtin: the declared mimeType decides the lane.
 * application/json and +json parse strictly; a declared-JSON body that
 * does not parse is a loud invocation error.
 */
function builtinMimeDecode(mimeType: string): (site: InvokeSite, raw: RawResult) => unknown {
  return (_site, raw) => {
    const mt = mimeType.split(";", 1)[0].trim();
    const body = typeof raw.body === "string" ? raw.body : String(raw.body);
    if (mt === "application/json" || mt.endsWith("+json")) {
      try {
        return JSON.parse(body);
      } catch (e) {
        throw new InvocationError(
          ERR_EXECUTION_FAILED,
          `resource declares ${mimeType} but its text is not valid JSON: ${(e as Error).message}`,
        );
      }
    }
    return body;
  };
}

/** Builds the hook-consultation site for an MCP binding. */
function siteFor(args: BindingInvocationArgs, target: string): InvokeSite {
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
  if (site.target === "") site.target = target;
  return site;
}

/** Get an MCP prompt. */
async function runPrompt(
  client: Client,
  promptName: string,
  promptArgs: Record<string, string> | undefined,
  inv: BindingHandle<unknown, unknown>,
  setHeaderOnce: () => void,
): Promise<void> {
  // An absent input omits the arguments member entirely (§9.1); a supplied
  // one was validated string-typed before dispatch (MCP-P-03).
  const params: { name: string; arguments?: Record<string, string> } = { name: promptName };
  if (promptArgs !== undefined) params.arguments = promptArgs;

  const result = await client.getPrompt(params, { signal: inv.signal });

  const output: Record<string, unknown> = { messages: result.messages };
  if (result.description) {
    output.description = result.description;
  }

  setHeaderOnce();
  await inv.emitOutput(output);
  inv.closeOutput();
}

/** Extract text from MCP content array for error messages. */
function extractContent(content: unknown): string {
  if (!Array.isArray(content)) return String(content);
  return content
    .map((c: { type?: string; text?: string }) => c.text ?? "")
    .filter(Boolean)
    .join("\n");
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

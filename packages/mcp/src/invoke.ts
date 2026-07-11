import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  InvocationError,
  buildAuthHeaders,
  httpErrorCode,
  ERR_CANCELLED,
  ERR_CONNECT_FAILED,
  ERR_EXECUTION_FAILED,
  ERR_INVALID_REF,
  ERR_SOURCE_CONFIG_ERROR,
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
 * Maps a thrown error to an InvocationError. JSON-RPC errors carry the MCP
 * error code/data in details; HTTP-status errors map via httpErrorCode;
 * anything else falls back to the phase's code (ERR_CONNECT_FAILED during
 * the initialize handshake, ERR_EXECUTION_FAILED during dispatch).
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
    return new InvocationError(httpErrorCode(e.code), msg, { status: e.code });
  }
  return new InvocationError(fallback, msg);
}

/**
 * Runs one MCP binding invocation against the handle. Each call opens a
 * fresh MCP session (Streamable HTTP), dispatches the entity call, emits
 * outputs (progress notifications first, then the result), and closes.
 *
 * Pre-dispatch failures (bad ref, missing endpoint, non-object input) fire
 * BEFORE any network I/O.
 */
export async function runMCPBinding(
  args: BindingInvocationArgs,
  inv: BindingHandle<unknown, unknown>,
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

  const location = args.source.location;
  if (!location) {
    inv.fireError(
      new InvocationError(ERR_SOURCE_CONFIG_ERROR, "MCP source requires a location (endpoint URL)"),
    );
    return;
  }
  if (!isHTTPURL(location)) {
    inv.fireError(
      new InvocationError(
        ERR_SOURCE_CONFIG_ERROR,
        `MCP source location must be an HTTP or HTTPS URL, got ${JSON.stringify(location)}`,
      ),
    );
    return;
  }

  // --- Collect input from the handle. ---
  // Tools and prompts take one named-arguments object; resource reads take
  // no input. Close input as early as possible so callers never have to.
  let input: Record<string, unknown> = {};
  if (args.binding !== undefined && args.inputSchema === undefined) {
    // Operation-layer no-input convention: the binding is populated but no
    // input schema is, so the operation declares NO input (e.g. a
    // zero-argument prompt or tool) — the caller never writes nor closes.
    // Close input on entry and dispatch with empty arguments.
    void inv.closeInput();
  } else if (entityType === "resources") {
    void inv.closeInput();
  } else {
    const first = await readFirst(inv.inputs());
    // Validate BEFORE closing input: a terminal validation error must
    // precede the observable input-close side effect (which resolves the
    // `inputClosed` promise conduit consumers await). On the validation
    // path, fireError itself closes the input side, keeping the terminal
    // and the input-close atomic.
    if (first != null && (typeof first !== "object" || Array.isArray(first))) {
      inv.fireError(
        new InvocationError(
          ERR_VALIDATION_FAILED,
          `MCP ${entityType === "tools" ? "tool" : "prompt"} input must be an object, got ${typeof first}`,
        ),
      );
      return;
    }
    void inv.closeInput();
    if (first != null) {
      input = first as Record<string, unknown>;
    }
  }

  if (inv.signal.aborted) return; // already terminal via ERR_CANCELLED

  // --- Connect: the MCP initialize handshake is the first network I/O. ---
  const authHeaders = buildAuthHeaders(args.context);
  const baseFetch = args.fetch ?? globalThis.fetch;

  // Capture HTTP response headers from POSTs (initialize, then the entity
  // call) so the latest capture at first-emit time is the call's response.
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

  // --- Dispatch. ---
  const site = siteFor(args, location);
  try {
    switch (entityType) {
      case "tools":
        await runTool(client, name, input, inv, setHeaderOnce, site, args.hooks);
        break;
      case "resources":
        await runResource(client, name, inv, setHeaderOnce, site, args.hooks);
        break;
      case "prompts":
        await runPrompt(client, name, input, inv, setHeaderOnce);
        break;
    }
  } catch (e: unknown) {
    inv.fireError(mapError(e, inv.signal, ERR_EXECUTION_FAILED));
  } finally {
    try { await client.close(); } catch { /* ignore close errors */ }
  }
}

/**
 * Invoke a tool call. Progress notifications stream as outputs ahead of the
 * final result -- multiple outputs are first-class on the handle.
 */
async function runTool(
  client: Client,
  toolName: string,
  toolArgs: Record<string, unknown>,
  inv: BindingHandle<unknown, unknown>,
  setHeaderOnce: () => void,
  site: InvokeSite,
  hooks: InvokeHooks | undefined,
): Promise<void> {
  // Progress callbacks are synchronous; chain the emits so they stay
  // ordered and observe emitOutput's backpressure without a side buffer.
  // Once an emit fails the invocation is terminal: the terminated flag
  // makes every queued and subsequent link a no-op.
  let progressChain: Promise<void> = Promise.resolve();
  let progressTerminated = false;

  const result = await client.callTool(
    { name: toolName, arguments: toolArgs },
    undefined,
    {
      signal: inv.signal,
      onprogress: (progress) => {
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
  await progressChain;

  if (result.isError) {
    throw new InvocationError(ERR_EXECUTION_FAILED, extractContent(result.content));
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
      { body: result.content[0].text },
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
 * Content-independent per the conventions record; JSON-in-text consumers
 * opt in with a decode hook.
 */
function builtinTextDecode(_site: InvokeSite, raw: RawResult): unknown {
  return typeof raw.body === "string" ? raw.body : String(raw.body);
}

/** Names the decode lane for the x-ob-decode stamp ("hook" when a hook decided). */
function decodeStampFor(hooks: InvokeHooks | undefined, builtin: string): string {
  return hooks?.decodeDecidedBy?.() === "hook" ? "hook" : builtin;
}

/** Read an MCP resource. */
async function runResource(
  client: Client,
  uri: string,
  inv: BindingHandle<unknown, unknown>,
  setHeaderOnce: () => void,
  site: InvokeSite,
  hooks: InvokeHooks | undefined,
): Promise<void> {
  const result = await client.readResource({ uri }, { signal: inv.signal });

  // Resources carry a DECLARED mimeType, so the builtin is the same
  // header-driven lane HTTP uses: json/+json parses strictly (a parse
  // failure is a loud error, never a silent fall-through), anything else
  // is text, and the payload's shape never picks the lane.
  let output: unknown;
  let decodeStamp = "content";
  const contents = result.contents;
  if (!contents || contents.length === 0) {
    output = null;
  } else if (contents.length === 1) {
    const c = contents[0];
    const text = "text" in c ? (c as { text: string }).text : undefined;
    if (text) {
      const mimeType = ("mimeType" in c ? (c as { mimeType?: string }).mimeType : undefined) ?? "";
      output = await decodeThroughHooks(hooks, site, { body: text }, builtinMimeDecode(mimeType));
      decodeStamp = decodeStampFor(hooks, "declared/mime-type");
    } else {
      output = c;
    }
  } else {
    output = contents;
  }

  setHeaderOnce();
  inv.setTrailer({ "x-ob-decode": [decodeStamp] });
  await inv.emitOutput(output);
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
        format: args.source.format,
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
  promptInput: Record<string, unknown>,
  inv: BindingHandle<unknown, unknown>,
  setHeaderOnce: () => void,
): Promise<void> {
  // Prompt arguments must be Record<string, string>.
  let promptArgs: Record<string, string> | undefined;
  if (Object.keys(promptInput).length > 0) {
    promptArgs = {};
    for (const [k, v] of Object.entries(promptInput)) {
      promptArgs[k] = String(v);
    }
  }

  const result = await client.getPrompt(
    { name: promptName, arguments: promptArgs },
    { signal: inv.signal },
  );

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

  // Check if all items are text. If so, join them verbatim (a single-item
  // array collapses to that one item's text; no separator is added).
  const allText = content.every(
    (c: { type?: string }) => c.type === "text",
  );
  if (allText) {
    return content
      .map((c: { text?: string }) => c.text ?? "")
      .join("\n");
  }

  // Mixed content types: return as array of structured items.
  return content;
}

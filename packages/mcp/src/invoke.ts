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

  // --- Collect input from the handle. ---
  // Tools and prompts take one named-arguments object; resource reads take
  // no input. Close input as early as possible so callers never have to.
  let input: Record<string, unknown> = {};
  if (entityType === "resources") {
    void inv.closeInput();
  } else {
    const first = await readFirst(inv.inputs());
    void inv.closeInput();
    if (first != null) {
      if (typeof first !== "object" || Array.isArray(first)) {
        inv.fireError(
          new InvocationError(
            ERR_VALIDATION_FAILED,
            `MCP ${entityType === "tools" ? "tool" : "prompt"} input must be an object, got ${typeof first}`,
          ),
        );
        return;
      }
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
  try {
    switch (entityType) {
      case "tools":
        await runTool(client, name, input, inv, setHeaderOnce);
        break;
      case "resources":
        await runResource(client, name, inv, setHeaderOnce);
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
): Promise<void> {
  // Progress callbacks are synchronous; chain the emits so they stay
  // ordered and observe emitOutput's backpressure without a side buffer.
  let progressChain: Promise<void> = Promise.resolve();

  const result = await client.callTool(
    { name: toolName, arguments: toolArgs },
    undefined,
    {
      signal: inv.signal,
      onprogress: (progress) => {
        progressChain = progressChain
          .then(() => {
            setHeaderOnce();
            return inv.emitOutput(progress);
          })
          .catch(() => { /* invocation terminated; stop emitting */ });
      },
    },
  );
  await progressChain;

  if (result.isError) {
    throw new InvocationError(ERR_EXECUTION_FAILED, extractContent(result.content));
  }

  // Prefer structuredContent if available.
  const output = result.structuredContent ?? parseContent(result.content);
  setHeaderOnce();
  await inv.emitOutput(output);
  inv.closeOutput();
}

/** Read an MCP resource. */
async function runResource(
  client: Client,
  uri: string,
  inv: BindingHandle<unknown, unknown>,
  setHeaderOnce: () => void,
): Promise<void> {
  const result = await client.readResource({ uri }, { signal: inv.signal });

  let output: unknown;
  const contents = result.contents;
  if (!contents || contents.length === 0) {
    output = null;
  } else if (contents.length === 1) {
    const c = contents[0];
    const text = "text" in c ? (c as { text: string }).text : undefined;
    if (text) {
      try {
        output = JSON.parse(text);
      } catch {
        output = text;
      }
    } else {
      output = c;
    }
  } else {
    output = contents;
  }

  setHeaderOnce();
  await inv.emitOutput(output);
  inv.closeOutput();
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

/** Parse MCP content array into a usable value. */
function parseContent(content: unknown): unknown {
  if (!Array.isArray(content) || content.length === 0) return content;

  // Single text content: try JSON parse.
  if (content.length === 1 && content[0].type === "text" && content[0].text) {
    try {
      return JSON.parse(content[0].text);
    } catch {
      return content[0].text;
    }
  }

  // Check if all items are text. If so, join them.
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

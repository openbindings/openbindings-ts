import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ExecuteOutput } from "@openbindings/sdk";
import {
  ERR_INVALID_REF,
  ERR_INVALID_INPUT,
  ERR_EXECUTION_FAILED,
  ERR_CONNECT_FAILED,
  ERR_AUTH_REQUIRED,
  ERR_PERMISSION_DENIED,
} from "@openbindings/sdk";

const CLIENT_NAME = "openbindings-mcp";
const CLIENT_VERSION = "0.1.0";

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

/**
 * Connect to an MCP server, returning a Client instance.
 * The caller is responsible for closing the client.
 */
async function connect(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Client> {
  const requestInit: RequestInit = {};
  if (Object.keys(headers).length > 0) {
    requestInit.headers = headers;
  }

  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit });
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
  await client.connect(transport);
  return client;
}

/** Execute a tool call. */
async function executeTool(
  client: Client,
  toolName: string,
  input: unknown,
): Promise<ExecuteOutput> {
  const start = performance.now();

  if (input != null && (typeof input !== "object" || Array.isArray(input))) {
    return {
      status: 1,
      durationMs: Math.round(performance.now() - start),
      error: { code: ERR_INVALID_INPUT, message: `tool input must be an object, got ${typeof input}` },
    };
  }
  const args = (input as Record<string, unknown>) ?? {};

  const result = await client.callTool({ name: toolName, arguments: args });
  const durationMs = Math.round(performance.now() - start);

  if (result.isError) {
    return {
      status: 1,
      durationMs,
      error: { code: ERR_EXECUTION_FAILED, message: extractContent(result.content) },
    };
  }

  // Prefer structuredContent if available.
  const output = result.structuredContent ?? parseContent(result.content);
  return { output, status: 0, durationMs };
}

/** Read an MCP resource. */
async function executeResource(
  client: Client,
  uri: string,
): Promise<ExecuteOutput> {
  const start = performance.now();
  const result = await client.readResource({ uri });
  const durationMs = Math.round(performance.now() - start);

  const contents = result.contents;
  if (!contents || contents.length === 0) {
    return { output: null, status: 0, durationMs };
  }

  if (contents.length === 1) {
    const c = contents[0];
    const text = "text" in c ? (c as { text: string }).text : undefined;
    if (text) {
      try {
        return { output: JSON.parse(text), status: 0, durationMs };
      } catch {
        return { output: text, status: 0, durationMs };
      }
    }
    return { output: c, status: 0, durationMs };
  }

  return { output: contents, status: 0, durationMs };
}

/** Get an MCP prompt. */
async function executePrompt(
  client: Client,
  promptName: string,
  input: unknown,
): Promise<ExecuteOutput> {
  const start = performance.now();

  // Prompt arguments must be Record<string, string>.
  let args: Record<string, string> | undefined;
  if (input != null && typeof input === "object" && !Array.isArray(input)) {
    args = {};
    for (const [k, v] of Object.entries(input)) {
      args[k] = String(v);
    }
  }

  const result = await client.getPrompt({ name: promptName, arguments: args });
  const durationMs = Math.round(performance.now() - start);

  const output: Record<string, unknown> = { messages: result.messages };
  if (result.description) {
    output.description = result.description;
  }
  return { output, status: 0, durationMs };
}

/**
 * Execute a binding against an MCP server. Each call creates a fresh session.
 */
export async function executeMCPBinding(
  url: string,
  ref: string,
  input: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<ExecuteOutput> {
  const { entityType, name } = parseRef(ref);

  const start = performance.now();
  let client: Client;
  try {
    client = await connect(url, headers, signal);
  } catch (e: unknown) {
    const durationMs = Math.round(performance.now() - start);
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("401") || msg.includes("Unauthorized")) {
      return { status: 401, durationMs, error: { code: ERR_AUTH_REQUIRED, message: msg } };
    }
    if (msg.includes("403") || msg.includes("Forbidden")) {
      return { status: 403, durationMs, error: { code: ERR_PERMISSION_DENIED, message: msg } };
    }
    return { status: 1, durationMs, error: { code: ERR_CONNECT_FAILED, message: msg } };
  }

  try {
    switch (entityType) {
      case "tools":
        return await executeTool(client, name, input);
      case "resources":
        return await executeResource(client, name);
      case "prompts":
        return await executePrompt(client, name, input);
      default:
        return {
          status: 1,
          durationMs: 0,
          error: { code: ERR_INVALID_REF, message: `unknown entity type "${entityType}"` },
        };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 1, durationMs: Math.round(performance.now() - start), error: { code: ERR_EXECUTION_FAILED, message: msg } };
  } finally {
    try { await client.close(); } catch { /* ignore close errors */ }
  }
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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OBInterface, Operation, BindingEntry, JSONSchema } from "@openbindings/sdk";
import { MAX_TESTED_VERSION } from "@openbindings/sdk";
import { FORMAT_TOKEN, DEFAULT_SOURCE_NAME } from "./constants.js";

const CLIENT_NAME = "openbindings-mcp";
const CLIENT_VERSION = "0.1.0";

interface MCPDiscovery {
  serverName?: string;
  serverVersion?: string;
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown> }>;
  resources: Array<{ name: string; uri: string; description?: string; mimeType?: string }>;
  resourceTemplates: Array<{ name: string; uriTemplate: string; description?: string; mimeType?: string }>;
  prompts: Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }>;
}

/** Discover capabilities from an MCP server. */
export async function discover(url: string, signal?: AbortSignal): Promise<MCPDiscovery> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
  await client.connect(transport);

  try {
    const serverVersion = client.getServerVersion();
    const caps = client.getServerCapabilities();

    const disc: MCPDiscovery = {
      serverName: serverVersion?.name,
      serverVersion: serverVersion?.version,
      tools: [],
      resources: [],
      resourceTemplates: [],
      prompts: [],
    };

    if (caps?.tools) {
      const result = await client.listTools();
      disc.tools = (result.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown> | undefined,
        outputSchema: (t as { outputSchema?: Record<string, unknown> }).outputSchema,
      }));
    }

    if (caps?.resources) {
      const result = await client.listResources();
      disc.resources = (result.resources ?? []).map((r) => ({
        name: r.name,
        uri: r.uri,
        description: r.description,
        mimeType: r.mimeType,
      }));

      const templates = await client.listResourceTemplates();
      disc.resourceTemplates = (templates.resourceTemplates ?? []).map((t) => ({
        name: t.name,
        uriTemplate: t.uriTemplate,
        description: t.description,
        mimeType: t.mimeType,
      }));
    }

    if (caps?.prompts) {
      const result = await client.listPrompts();
      disc.prompts = (result.prompts ?? []).map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments?.map((a) => ({
          name: a.name,
          description: a.description,
          required: a.required,
        })),
      }));
    }

    return disc;
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

/** Sanitize a name for use as an OBI operation key. */
function sanitizeKey(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+|_+$/g, "") || "unnamed";
}

/** Resolve key collisions by prefixing with entity type. */
function resolveKey(key: string, entityType: string, used: Map<string, string>): string {
  if (!used.has(key)) return key;
  const prefixed = `${entityType}_${key}`;
  if (!used.has(prefixed)) return prefixed;
  for (let i = 2; ; i++) {
    const numbered = `${prefixed}_${i}`;
    if (!used.has(numbered)) return numbered;
  }
}

/** Convert an MCP discovery result to an OBInterface. */
export function convertToInterface(disc: MCPDiscovery, location?: string): OBInterface {
  const operations: Record<string, Operation> = {};
  const bindings: Record<string, BindingEntry> = {};
  const usedKeys = new Map<string, string>();

  const source: { format: string; location?: string } = { format: FORMAT_TOKEN };
  if (location) source.location = location;

  // Sort all entities alphabetically for deterministic output.
  const tools = [...disc.tools].sort((a, b) => a.name.localeCompare(b.name));
  const resources = [...disc.resources].sort((a, b) => a.name.localeCompare(b.name));
  const templates = [...disc.resourceTemplates].sort((a, b) => a.name.localeCompare(b.name));
  const prompts = [...disc.prompts].sort((a, b) => a.name.localeCompare(b.name));

  // Tools
  for (const tool of tools) {
    const ref = `tools/${tool.name}`;
    const opKey = resolveKey(sanitizeKey(tool.name), "tool", usedKeys);
    usedKeys.set(opKey, ref);

    const op: Operation = {};
    if (tool.description) op.description = tool.description;
    if (tool.inputSchema) op.input = tool.inputSchema as JSONSchema;
    if (tool.outputSchema) op.output = tool.outputSchema as JSONSchema;

    operations[opKey] = op;
    bindings[`${opKey}.${DEFAULT_SOURCE_NAME}`] = { operation: opKey, source: DEFAULT_SOURCE_NAME, ref };
  }

  // Resources
  for (const res of resources) {
    const ref = `resources/${res.uri}`;
    const opKey = resolveKey(sanitizeKey(res.name), "resource", usedKeys);
    usedKeys.set(opKey, ref);

    const op: Operation = {};
    if (res.description) op.description = res.description;
    op.input = {
      type: "object",
      properties: {
        uri: { type: "string", const: res.uri },
      },
    } as JSONSchema;

    operations[opKey] = op;
    bindings[`${opKey}.${DEFAULT_SOURCE_NAME}`] = { operation: opKey, source: DEFAULT_SOURCE_NAME, ref };
  }

  // Resource templates
  for (const tmpl of templates) {
    const ref = `resources/${tmpl.uriTemplate}`;
    const opKey = resolveKey(sanitizeKey(tmpl.name), "resource_template", usedKeys);
    usedKeys.set(opKey, ref);

    const op: Operation = {};
    if (tmpl.description) op.description = tmpl.description;
    op.input = {
      type: "object",
      properties: {
        uriTemplate: { type: "string", const: tmpl.uriTemplate },
      },
    } as JSONSchema;

    operations[opKey] = op;
    bindings[`${opKey}.${DEFAULT_SOURCE_NAME}`] = { operation: opKey, source: DEFAULT_SOURCE_NAME, ref };
  }

  // Prompts
  for (const prompt of prompts) {
    const ref = `prompts/${prompt.name}`;
    const opKey = resolveKey(sanitizeKey(prompt.name), "prompt", usedKeys);
    usedKeys.set(opKey, ref);

    const op: Operation = {};
    if (prompt.description) op.description = prompt.description;

    // Input from prompt arguments.
    if (prompt.arguments && prompt.arguments.length > 0) {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const arg of prompt.arguments) {
        const prop: Record<string, unknown> = { type: "string" };
        if (arg.description) prop.description = arg.description;
        properties[arg.name] = prop;
        if (arg.required) required.push(arg.name);
      }
      const input: Record<string, unknown> = { type: "object", properties };
      if (required.length > 0) input.required = required.sort();
      op.input = input as JSONSchema;
    }

    // Standard prompt output schema.
    op.output = {
      type: "object",
      properties: {
        messages: { type: "array" },
        description: { type: "string" },
      },
    } as JSONSchema;

    operations[opKey] = op;
    bindings[`${opKey}.${DEFAULT_SOURCE_NAME}`] = { operation: opKey, source: DEFAULT_SOURCE_NAME, ref };
  }

  const iface: OBInterface = {
    openbindings: MAX_TESTED_VERSION,
    operations,
    sources: { [DEFAULT_SOURCE_NAME]: source },
    bindings,
  };

  if (disc.serverName) iface.name = disc.serverName;
  if (disc.serverVersion) iface.version = disc.serverVersion;

  return iface;
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import type { OBInterface, Operation, BindingEntry, JSONSchema } from "@openbindings/core";
import { MAX_TESTED_VERSION } from "@openbindings/core";
import { CLIENT_NAME, CLIENT_VERSION, BINDING_SPEC, DEFAULT_SOURCE_NAME } from "./constants.js";
import { exhaustPages, parsePinnedListing } from "./listing.js";

export interface MCPDiscovery {
  serverName?: string;
  serverVersion?: string;
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown>; taskSupport?: "optional" | "required" | "forbidden" }>;
  resources: Array<{ name: string; uri: string; description?: string; mimeType?: string }>;
  resourceTemplates: Array<{ name: string; uriTemplate: string; description?: string; mimeType?: string }>;
  prompts: Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }>;
  /** Raw pagination-exhausted entity arrays, suitable for source.content. */
  pinnedListing?: {
    tools: unknown[];
    resources: unknown[];
    resourceTemplates: unknown[];
    prompts: unknown[];
  };
}

/** Options threaded through discovery: cancellation and the fetch seam. */
export interface DiscoverOptions {
  signal?: AbortSignal;
  /**
   * Overrides the fetch implementation the Streamable HTTP transport uses
   * to reach the MCP server during discovery. Mirrors the Go SDK's
   * WithSynthesizerHTTPClient (client.go/invoker.go): a corporate proxy,
   * mTLS client certificate, or custom CA pool that the invocation lane
   * needs is needed here too, since discovery connects live.
   */
  fetch?: typeof globalThis.fetch;
}

/** Discover capabilities from an MCP server. */
export async function discover(url: string, options?: DiscoverOptions): Promise<MCPDiscovery> {
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    options?.fetch ? { fetch: options.fetch } : undefined,
  );
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
  await client.connect(transport, options?.signal ? { signal: options.signal } : undefined);

  try {
    if (transport.protocolVersion !== "2025-11-25") {
      throw new Error(
        `negotiated MCP protocol revision ${JSON.stringify(transport.protocolVersion)} is outside this implementation's accepted envelope (2025-11-25)`,
      );
    }

    const serverVersion = client.getServerVersion();
    const caps = client.getServerCapabilities();

    const disc: MCPDiscovery = {
      serverName: serverVersion?.name,
      serverVersion: serverVersion?.version,
      tools: [],
      resources: [],
      resourceTemplates: [],
      prompts: [],
      pinnedListing: { tools: [], resources: [], resourceTemplates: [], prompts: [] },
    };

    // Each list request follows nextCursor to pagination exhaustion
    // (MCP-P-02): the artifact is always the pagination-exhausted
    // aggregate (openbindings.mcp §3) — a first-page-only discovery
    // would synthesize a truncated interface.
    if (caps?.tools) {
      await exhaustPages(
        (cursor) => client.listTools(cursor !== undefined ? { cursor } : undefined),
        (result) => {
          for (const t of result.tools ?? []) {
            disc.pinnedListing?.tools.push(t);
            disc.tools.push({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              outputSchema: (t as { outputSchema?: Record<string, unknown> }).outputSchema,
              taskSupport: (t as { execution?: { taskSupport?: "optional" | "required" | "forbidden" } }).execution?.taskSupport,
            });
          }
        },
      );
    }

    if (caps?.resources) {
      await exhaustPages(
        (cursor) => client.listResources(cursor !== undefined ? { cursor } : undefined),
        (result) => {
          for (const r of result.resources ?? []) {
            disc.pinnedListing?.resources.push(r);
            disc.resources.push({
              name: r.name,
              uri: r.uri,
              description: r.description,
              mimeType: r.mimeType,
            });
          }
        },
      );

      await exhaustPages(
        (cursor) => client.listResourceTemplates(cursor !== undefined ? { cursor } : undefined),
        (result) => {
          for (const t of result.resourceTemplates ?? []) {
            disc.pinnedListing?.resourceTemplates.push(t);
            disc.resourceTemplates.push({
              name: t.name,
              uriTemplate: t.uriTemplate,
              description: t.description,
              mimeType: t.mimeType,
            });
          }
        },
      );
    }

    if (caps?.prompts) {
      await exhaustPages(
        (cursor) => client.listPrompts(cursor !== undefined ? { cursor } : undefined),
        (result) => {
          for (const p of result.prompts ?? []) {
            disc.pinnedListing?.prompts.push(p);
            disc.prompts.push({
              name: p.name,
              description: p.description,
              arguments: p.arguments?.map((a) => ({
                name: a.name,
                description: a.description,
                required: a.required,
              })),
            });
          }
        },
      );
    }

    return disc;
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

/**
 * Decodes a pinned listing (MCP-D-01) into the synthesis lanes' discovery
 * view. The same grammar validation `parsePinnedListing` applies — stray
 * members, entity-array shapes, identity members, all refused loudly —
 * followed by decoding the 2025-11-25 entity members the synthesis lanes
 * read (descriptions, schemas, prompt arguments), refused loudly when they
 * contradict those shapes (Go parity: pinnedDiscovery, listing.go). The pin
 * is authoritative (§6 content primacy): the server is never dialed. A pin
 * carries no serverInfo, so the interface's name/version, when wanted, come
 * from SynthesizeInput.
 */
export function pinnedDiscovery(content: unknown): MCPDiscovery {
  const listing = parsePinnedListing(content);
  const members = content as {
    tools?: Record<string, unknown>[];
    resources?: Record<string, unknown>[];
    resourceTemplates?: Record<string, unknown>[];
    prompts?: Record<string, unknown>[];
  };

  const bad = (where: string, detail: string): Error =>
    new Error(
      `MCP pinned listing entities do not decode as the 2025-11-25 result shapes (MCP-D-01): ${where} ${detail}`,
    );
  const optString = (entry: Record<string, unknown>, key: string, where: string): string | undefined => {
    const v = entry[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string") throw bad(where, `member ${JSON.stringify(key)} must be a string`);
    return v;
  };
  const optObject = (
    entry: Record<string, unknown>,
    key: string,
    where: string,
  ): Record<string, unknown> | undefined => {
    const v = entry[key];
    if (v === undefined) return undefined;
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      throw bad(where, `member ${JSON.stringify(key)} must be an object`);
    }
    return v as Record<string, unknown>;
  };
  const promptArguments = (
    entry: Record<string, unknown>,
    where: string,
  ): Array<{ name: string; description?: string; required?: boolean }> | undefined => {
    const raw = entry["arguments"];
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) throw bad(where, `member "arguments" must be an array`);
    return raw.map((a, j) => {
      if (a === null || typeof a !== "object" || Array.isArray(a)) {
        throw bad(`${where}.arguments[${j}]`, "must be an object");
      }
      const arg = a as Record<string, unknown>;
      const required = arg["required"];
      if (required !== undefined && typeof required !== "boolean") {
        throw bad(`${where}.arguments[${j}]`, `member "required" must be a boolean`);
      }
      return {
        name: optString(arg, "name", `${where}.arguments[${j}]`) ?? "",
        description: optString(arg, "description", `${where}.arguments[${j}]`),
        required,
      };
    });
  };

  return {
    tools: (members.tools ?? []).map((t, i) => ({
      name: t["name"] as string, // the identity member, validated by parsePinnedListing
      description: optString(t, "description", `tools[${i}]`),
      inputSchema: optObject(t, "inputSchema", `tools[${i}]`),
      outputSchema: optObject(t, "outputSchema", `tools[${i}]`),
      taskSupport: listing.requiredTaskTools?.includes(t["name"] as string) ? "required" : undefined,
    })),
    resources: (members.resources ?? []).map((r, i) => ({
      name: optString(r, "name", `resources[${i}]`) ?? "",
      uri: r["uri"] as string, // identity
      description: optString(r, "description", `resources[${i}]`),
      mimeType: optString(r, "mimeType", `resources[${i}]`),
    })),
    resourceTemplates: (members.resourceTemplates ?? []).map((t, i) => ({
      name: optString(t, "name", `resourceTemplates[${i}]`) ?? "",
      uriTemplate: t["uriTemplate"] as string, // identity
      description: optString(t, "description", `resourceTemplates[${i}]`),
      mimeType: optString(t, "mimeType", `resourceTemplates[${i}]`),
    })),
    prompts: (members.prompts ?? []).map((p, i) => ({
      name: p["name"] as string, // identity
      description: optString(p, "description", `prompts[${i}]`),
      arguments: promptArguments(p, `prompts[${i}]`),
    })),
  };
}

/**
 * Derives a resource template's input schema from its RFC 6570 variables —
 * the operation's input value per openbindings.mcp@1 §8/§9.1: one string
 * property per declared variable (using RFC 6570's string/list/associative
 * value domain), none required (an unsupplied variable follows RFC 6570's
 * undefined-value expansion), and no undeclared members (the invoker
 * refuses them, hence additionalProperties: false). Mirrors the Go SDK's
 * templateInputSchema (synthesize.go). Eligibility filters malformed
 * templates before this function is called.
 */
function templateInputSchema(template: string): JSONSchema | undefined {
  let tmpl: UriTemplate;
  try {
    tmpl = new UriTemplate(template);
  } catch {
    return undefined;
  }
  const properties: Record<string, unknown> = {};
  for (const name of tmpl.variableNames) {
    properties[name] = {
      anyOf: [
        { type: "string" },
        { type: "array", items: { type: "string" } },
        { type: "object", additionalProperties: { type: "string" } },
      ],
    };
  }
  return {
    type: "object",
    description: `Variables of RFC 6570 template ${JSON.stringify(template)}`,
    properties,
    additionalProperties: false,
  };
}

/**
 * The standard MCP GetPromptResult output schema: an object with a
 * required `messages` array (each item shaped {role, content}) and an
 * optional `description`. Mirrors the Go SDK's promptOutputSchema()
 * (synthesize.go) field for field -- the convention record's Invocation
 * shape section states prompts output "{messages, description?}", so
 * `messages` is required and `description` is not.
 */
function promptOutputSchema(): JSONSchema {
  return {
    type: "object",
    properties: {
      description: { type: "string", description: "Optional description of the prompt result" },
      messages: {
        type: "array",
        description: "Sequence of LLM messages",
        items: {
          type: "object",
          properties: {
            role: { type: "string" },
            content: {},
          },
          required: ["role", "content"],
        },
      },
    },
    required: ["messages"],
  };
}

/** Complete successful CallToolResult; outputSchema constrains structuredContent. */
function toolResultOutputSchema(outputSchema?: Record<string, unknown>): JSONSchema {
  const properties: Record<string, unknown> = {
    _meta: { type: "object" },
    content: { type: "array", items: { type: "object" } },
    isError: { const: false },
  };
  if (outputSchema) properties.structuredContent = outputSchema;
  return {
    type: "object",
    anyOf: [
      {
        properties: {
          progress: { type: "number" },
          total: { type: "number" },
          message: { type: "string" },
        },
        required: ["progress"],
      },
      { properties, required: ["content"] },
    ],
  };
}

/** Complete ReadResourceResult emitted by either resource binding family. */
function resourceOutputSchema(): JSONSchema {
  return {
    type: "object",
    properties: {
      _meta: { type: "object" },
      contents: {
        type: "array",
        items: {
          type: "object",
          properties: {
            uri: { type: "string" },
            mimeType: { type: "string" },
            text: { type: "string" },
            blob: { type: "string" },
          },
          required: ["uri"],
          oneOf: [
            { required: ["text"] },
            { required: ["blob"] },
          ],
        },
      },
    },
    required: ["contents"],
  };
}

/**
 * Sanitize a name for use as an OBI operation key. Exported (alongside
 * {@link resolveKey}) so inspectSource can suggest the same operationKey
 * synthesizeInterface assigns, matching the Go SDK's InspectSource
 * (list_refs.go), which shares this exact key-assignment logic with
 * SynthesizeInterface "so an inspection previews exactly what synthesis
 * names."
 */
export function sanitizeKey(name: string): string {
  // The u flag makes the class match whole code points, so an astral-plane
  // character replaces as one underscore, not one per surrogate half
  // (Go parity: SanitizeKey's regexp operates on runes).
  const key = name.replace(/[^a-zA-Z0-9._-]/gu, "_").replace(/^_+|_+$/g, "");
  if (!key) return "unnamed";
  // OBI-D-03 requires the first character to be a letter or underscore
  // (Go parity: SanitizeKey).
  return /^[A-Za-z_]/.test(key) ? key : `_${key}`;
}

/**
 * Compares strings by Unicode code point: the canonical ordering for
 * synthesis and inspection (Go parity: Go compares strings byte-wise, and
 * UTF-8 byte order is code point order). Neither `localeCompare` (collates
 * under the host locale, so output varies machine to machine) nor default
 * sort / UTF-16 code-unit `<` (ranks astral-plane code points below
 * U+E000..U+FFFF) matches the reference implementation. The order is
 * load-bearing beyond emission: it decides which of two colliding names
 * wins the bare key in {@link resolveKey}.
 */
export function codePointCompare(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length) {
    const ca = a.codePointAt(i) as number; // i < a.length, so defined
    const cb = b.codePointAt(i) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

/** Resolve key collisions by prefixing with entity type. */
export function resolveKey(key: string, entityType: string, used: Map<string, string>): string {
  if (!used.has(key)) return key;
  const prefixed = `${entityType}_${key}`;
  if (!used.has(prefixed)) return prefixed;
  for (let i = 2; ; i++) {
    const numbered = `${prefixed}_${i}`;
    if (!used.has(numbered)) return numbered;
  }
}

/** Convert an MCP discovery result to an OBInterface. */
export function convertToInterface(
  disc: MCPDiscovery,
  location?: string,
  bindingSpec = BINDING_SPEC,
): OBInterface {
  const operations: Record<string, Operation> = {};
  const bindings: Record<string, BindingEntry> = {};
  const usedKeys = new Map<string, string>();

  const source: { bindingSpec: string; location?: string } = { bindingSpec };
  if (location) source.location = location;

  disc = bindableDiscovery(disc, bindingSpec);

  // Sort all bindable entities by name, code point order, for deterministic output.
  const tools = [...disc.tools].sort((a, b) => codePointCompare(a.name, b.name));
  const resources = [...disc.resources].sort((a, b) => codePointCompare(a.name, b.name));
  const templates = [...disc.resourceTemplates].sort((a, b) => codePointCompare(a.name, b.name));
  const prompts = [...disc.prompts].sort((a, b) => codePointCompare(a.name, b.name));

  // Tools
  for (const tool of tools) {
    const selector = `tools/${tool.name}`;
    const opKey = resolveKey(sanitizeKey(tool.name), "tool", usedKeys);
    usedKeys.set(opKey, selector);

    const op: Operation = {};
    if (tool.description) op.description = tool.description;
    if (tool.inputSchema) op.input = tool.inputSchema;
    op.output = bindingSpec === BINDING_SPEC
      ? tool.outputSchema
      : toolResultOutputSchema(tool.outputSchema);

    operations[opKey] = op;
    bindings[`${opKey}.${DEFAULT_SOURCE_NAME}`] = { operation: opKey, source: DEFAULT_SOURCE_NAME, selector };
  }

  // Resources: static resources take no input value (openbindings.mcp@1
  // §8/§9.1): the URI is the binding's selector, not caller input, so the
  // operation declares no input schema.
  for (const res of resources) {
    const selector = `resources/${res.uri}`;
    const opKey = resolveKey(sanitizeKey(res.name), "resource", usedKeys);
    usedKeys.set(opKey, selector);

    const op: Operation = {};
    if (res.description) op.description = res.description;
    op.output = resourceOutputSchema();

    operations[opKey] = op;
    bindings[`${opKey}.${DEFAULT_SOURCE_NAME}`] = { operation: opKey, source: DEFAULT_SOURCE_NAME, selector };
  }

  // Resource templates: the operation's input value is the object of the
  // template's RFC 6570 variables (§8/§9.1).
  for (const tmpl of templates) {
    const selector = `resourceTemplates/${tmpl.uriTemplate}`;
    const opKey = resolveKey(sanitizeKey(tmpl.name), "resource_template", usedKeys);
    usedKeys.set(opKey, selector);

    const op: Operation = {};
    if (tmpl.description) op.description = tmpl.description;
    const input = templateInputSchema(tmpl.uriTemplate);
    if (input) op.input = input;
    op.output = resourceOutputSchema();

    operations[opKey] = op;
    bindings[`${opKey}.${DEFAULT_SOURCE_NAME}`] = { operation: opKey, source: DEFAULT_SOURCE_NAME, selector };
  }

  // Prompts
  for (const prompt of prompts) {
    const selector = `prompts/${prompt.name}`;
    const opKey = resolveKey(sanitizeKey(prompt.name), "prompt", usedKeys);
    usedKeys.set(opKey, selector);

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
      if (required.length > 0) input.required = required.sort(codePointCompare);
      op.input = input;
    }

    // Standard prompt output schema.
    op.output = promptOutputSchema();

    operations[opKey] = op;
    bindings[`${opKey}.${DEFAULT_SOURCE_NAME}`] = { operation: opKey, source: DEFAULT_SOURCE_NAME, selector };
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

/**
 * Applies the binding specification's own resolution boundary. Ambiguous
 * identities, required-task tools, and malformed RFC 6570 templates are not
 * binding targets in revision 1. Synthesis and inspection share this helper
 * so neither can advertise a selector invocation is statically bound to refuse.
 */
export function bindableDiscovery(
  disc: MCPDiscovery,
  bindingSpec = BINDING_SPEC,
): MCPDiscovery {
  const counts = <T>(items: T[], identity: (item: T) => string): Map<string, number> => {
    const result = new Map<string, number>();
    for (const item of items) {
      const key = identity(item);
      result.set(key, (result.get(key) ?? 0) + 1);
    }
    return result;
  };
  const toolCounts = counts(disc.tools, (v) => v.name);
  const resourceCounts = counts(disc.resources, (v) => v.uri);
  const templateCounts = counts(disc.resourceTemplates, (v) => v.uriTemplate);
  const promptCounts = counts(disc.prompts, (v) => v.name);
  const validTemplate = (value: string): boolean => {
    try {
      new UriTemplate(value);
      return true;
    } catch {
      return false;
    }
  };
  return {
    serverName: disc.serverName,
    serverVersion: disc.serverVersion,
    tools: disc.tools.filter((v) => v.name !== "" && toolCounts.get(v.name) === 1 && v.taskSupport !== "required" && (bindingSpec !== BINDING_SPEC || v.outputSchema !== undefined)),
    resources: bindingSpec === BINDING_SPEC ? [] : disc.resources.filter((v) => v.uri !== "" && resourceCounts.get(v.uri) === 1),
    resourceTemplates: bindingSpec === BINDING_SPEC ? [] : disc.resourceTemplates.filter((v) => v.uriTemplate !== "" && templateCounts.get(v.uriTemplate) === 1 && validTemplate(v.uriTemplate)),
    prompts: bindingSpec === BINDING_SPEC ? [] : disc.prompts.filter((v) => v.name !== "" && promptCounts.get(v.name) === 1),
  };
}

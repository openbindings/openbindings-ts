import {
  ERR_AUTH_REQUIRED,
  ERR_INVALID_REF,
  ERR_SOURCE_LOAD_FAILED,
  NoSourcesError,
  resolveSecurity,
  buildAuthHeaders,
  normalizeEndpoint,
  type BindingInvoker,
  type InterfaceCreator,
  type SourceInspector,
  type BindingInvocationInput,
  type CreateInput,
  type OBInterface,
  type InvocationOutput,
  type FormatInfo,
  type Source,
  type SourceInspection,
} from "@openbindings/sdk";
import { FORMAT_TOKEN } from "./constants.js";
import { invokeMCPBinding, parseRef } from "./invoke.js";
import { discover, convertToInterface } from "./create.js";

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/** Invokes MCP bindings by connecting to MCP servers via Streamable HTTP. */
export class MCPInvoker implements BindingInvoker {
  formats(): FormatInfo[] {
    return [{ token: FORMAT_TOKEN, description: "MCP via Streamable HTTP" }];
  }

  async *invokeBinding(
    input: BindingInvocationInput,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<InvocationOutput> {
    // Validate ref early.
    try {
      parseRef(input.ref);
    } catch (e: unknown) {
      yield { error: { code: ERR_INVALID_REF, message: e instanceof Error ? e.message : String(e) } };
      return;
    }

    if (!input.source.location) {
      yield { error: { code: ERR_SOURCE_LOAD_FAILED, message: "MCP source requires a location (endpoint URL)" } };
      return;
    }
    const location = input.source.location;

    const enriched = await this.resolveStoreContext(input);
    const headers = buildAuthHeaders(enriched.context);

    let result = await invokeMCPBinding(
      location,
      enriched.ref,
      enriched.input,
      headers,
      options?.signal,
    );

    // Auth retry.
    if (result.error?.code === ERR_AUTH_REQUIRED && enriched.security?.length && enriched.callbacks) {
      const creds = await resolveSecurity(enriched.security, enriched.callbacks, enriched.fetch);
      if (creds) {
        const retryInput = {
          ...enriched,
          context: { ...enriched.context, ...creds },
        };
        if (retryInput.store) {
          const key = normalizeEndpoint(location);
          if (key) {
            try { await retryInput.store.set(key, retryInput.context!); } catch { /* ignore */ }
          }
        }
        const retryHeaders = buildAuthHeaders(retryInput.context);
        result = await invokeMCPBinding(
          location,
          retryInput.ref,
          retryInput.input,
          retryHeaders,
          options?.signal,
        );
      }
    }

    if (result.error) {
      yield { error: result.error, status: result.status, durationMs: result.durationMs };
    } else {
      yield { output: result.output, status: result.status, durationMs: result.durationMs };
    }
  }

  private async resolveStoreContext(
    input: BindingInvocationInput,
  ): Promise<BindingInvocationInput> {
    if (!input.store || !input.source.location) return input;

    const key = normalizeEndpoint(input.source.location);
    if (!key) return input;

    let stored: Record<string, unknown> | null;
    try {
      stored = await input.store.get(key);
    } catch {
      return input;
    }
    if (!stored) return input;

    const merged = input.context && Object.keys(input.context).length > 0
      ? { ...stored, ...input.context }
      : stored;

    return { ...input, context: merged };
  }
}

// ---------------------------------------------------------------------------
// Creator
// ---------------------------------------------------------------------------

/** Creates OBInterface definitions by discovering an MCP server's capabilities. */
export class MCPCreator implements InterfaceCreator, SourceInspector {
  formats(): FormatInfo[] {
    return [{ token: FORMAT_TOKEN, description: "MCP via Streamable HTTP" }];
  }

  async createInterface(
    input: CreateInput,
    options?: { signal?: AbortSignal },
  ): Promise<OBInterface> {
    if (!input.sources?.length) {
      throw new NoSourcesError();
    }
    const src = input.sources[0];
    if (!src.location) {
      throw new Error("MCP source requires a location (endpoint URL)");
    }

    const disc = await discover(src.location, options?.signal);
    const iface = convertToInterface(disc, src.location);
    if (input.name) iface.name = input.name;
    if (input.version) iface.version = input.version;
    if (input.description) iface.description = input.description;
    return iface;
  }

  /** Lists all bindable targets (tools, resources, prompts) from an MCP server. */
  async inspectSource(
    source: Source,
    options?: { signal?: AbortSignal },
  ): Promise<SourceInspection> {
    if (!source.location) throw new Error("MCP source requires a location (endpoint URL)");
    const disc = await discover(source.location, options?.signal);
    const targets: SourceInspection["targets"] = [];

    for (const tool of disc.tools.sort((a, b) => a.name.localeCompare(b.name))) {
      targets.push({ ref: `tools/${tool.name}`, operation: tool.description ? { description: tool.description } : undefined });
    }
    for (const res of disc.resources.sort((a, b) => a.name.localeCompare(b.name))) {
      targets.push({ ref: `resources/${res.uri}`, operation: res.description ? { description: res.description } : undefined });
    }
    for (const tmpl of disc.resourceTemplates.sort((a, b) => a.name.localeCompare(b.name))) {
      targets.push({ ref: `resources/${tmpl.uriTemplate}`, operation: tmpl.description ? { description: tmpl.description } : undefined });
    }
    for (const prompt of disc.prompts.sort((a, b) => a.name.localeCompare(b.name))) {
      targets.push({ ref: `prompts/${prompt.name}`, operation: prompt.description ? { description: prompt.description } : undefined });
    }

    return { targets, exhaustive: true };
  }
}

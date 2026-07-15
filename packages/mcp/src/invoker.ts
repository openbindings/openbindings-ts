import {
  ERR_RUNTIME,
  InvocationError,
  InvocationImpl,
  NoSourcesError,
  MultipleSourcesError,
  type BindingInvocationArgs,
  type BindingInvoker,
  type SynthesizeInput,
  type BindingSpecInfo,
  type InterfaceSynthesizer,
  type Invocation,
  type OBInterface,
  type Source,
  type SourceInspection,
  type SourceInspector,
} from "@openbindings/sdk";
import { BINDING_SPEC } from "./constants.js";
import { runMCPBinding } from "./invoke.js";
import { discover, convertToInterface, sanitizeKey, resolveKey } from "./synthesize.js";

// ---------------------------------------------------------------------------
// Invoker
// ---------------------------------------------------------------------------

/** Invokes MCP bindings by connecting to MCP servers via Streamable HTTP. */
export class MCPInvoker implements BindingInvoker {
  bindingSpecs(): BindingSpecInfo[] {
    return [{ bindingSpec: BINDING_SPEC, description: "MCP via Streamable HTTP" }];
  }

  /**
   * Returns the invocation handle synchronously; the MCP session work is
   * scheduled asynchronously. Tool and prompt arguments arrive as the
   * operation's single input message through the handle's `write` channel;
   * resource reads take no input (the binding closes the input side on
   * entry). Pre-dispatch failures (bad ref, missing endpoint, non-object
   * input) terminate the handle before any network side effect.
   */
  invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
    const inv = new InvocationImpl<unknown, unknown>({ signal: args.signal });
    queueMicrotask(() => {
      runMCPBinding(args, inv).catch((err: unknown) => {
        inv.fireError(
          err instanceof InvocationError
            ? err
            : new InvocationError(ERR_RUNTIME, err instanceof Error ? err.message : String(err)),
        );
      });
    });
    return inv as Invocation<I, O>;
  }
}

// ---------------------------------------------------------------------------
// Synthesizer
// ---------------------------------------------------------------------------

/** Constructor options for {@link MCPSynthesizer}. */
export interface MCPSynthesizerOptions {
  /**
   * Overrides the fetch implementation discovery uses to reach the MCP
   * server. Mirrors the Go SDK's WithSynthesizerHTTPClient (invoker.go): a
   * corporate proxy, mTLS client certificate, or custom CA pool that the
   * invocation lane needs (BindingInvocationArgs.fetch) is needed here
   * too, since discovery connects live. Unset means the ambient global
   * fetch, same as before this option existed.
   */
  fetch?: typeof globalThis.fetch;
}

/** Synthesizes OBInterface definitions by discovering an MCP server's capabilities. */
export class MCPSynthesizer implements InterfaceSynthesizer, SourceInspector {
  private readonly fetchImpl?: typeof globalThis.fetch;

  constructor(options?: MCPSynthesizerOptions) {
    this.fetchImpl = options?.fetch;
  }

  bindingSpecs(): BindingSpecInfo[] {
    return [{ bindingSpec: BINDING_SPEC, description: "MCP via Streamable HTTP" }];
  }

  async synthesizeInterface(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<OBInterface> {
    if (!input.sources?.length) {
      throw new NoSourcesError();
    }
    if (input.sources.length > 1) {
      throw new MultipleSourcesError();
    }
    const src = input.sources[0];
    if (!src.location) {
      throw new Error("MCP source requires a location (endpoint URL)");
    }

    const disc = await discover(src.location, { signal: options?.signal, fetch: this.fetchImpl });
    const iface = convertToInterface(disc, src.location);
    if (input.name) iface.name = input.name;
    if (input.version) iface.version = input.version;
    if (input.description) iface.description = input.description;
    return iface;
  }

  /**
   * Lists all bindable targets (tools, resources, prompts) from an MCP
   * server. Each target's operationKey is the same SanitizeKey +
   * collision-resolved key synthesizeInterface would assign it (one
   * usedKeys map shared across all four entity kinds, in the same
   * tools/resources/resourceTemplates/prompts order convertToInterface
   * uses), so an inspection previews exactly what synthesis names.
   */
  async inspectSource(
    source: Source,
    options?: { signal?: AbortSignal },
  ): Promise<SourceInspection> {
    if (!source.location) throw new Error("MCP source requires a location (endpoint URL)");
    const disc = await discover(source.location, { signal: options?.signal, fetch: this.fetchImpl });
    const targets: SourceInspection["targets"] = [];
    const usedKeys = new Map<string, string>();

    for (const tool of disc.tools.sort((a, b) => a.name.localeCompare(b.name))) {
      const ref = `tools/${tool.name}`;
      const operationKey = resolveKey(sanitizeKey(tool.name), "tool", usedKeys);
      usedKeys.set(operationKey, ref);
      targets.push({ ref, operationKey, operation: tool.description ? { description: tool.description } : undefined });
    }
    for (const res of disc.resources.sort((a, b) => a.name.localeCompare(b.name))) {
      const ref = `resources/${res.uri}`;
      const operationKey = resolveKey(sanitizeKey(res.name), "resource", usedKeys);
      usedKeys.set(operationKey, ref);
      targets.push({ ref, operationKey, operation: res.description ? { description: res.description } : undefined });
    }
    for (const tmpl of disc.resourceTemplates.sort((a, b) => a.name.localeCompare(b.name))) {
      const ref = `resources/${tmpl.uriTemplate}`;
      const operationKey = resolveKey(sanitizeKey(tmpl.name), "resource_template", usedKeys);
      usedKeys.set(operationKey, ref);
      targets.push({ ref, operationKey, operation: tmpl.description ? { description: tmpl.description } : undefined });
    }
    for (const prompt of disc.prompts.sort((a, b) => a.name.localeCompare(b.name))) {
      const ref = `prompts/${prompt.name}`;
      const operationKey = resolveKey(sanitizeKey(prompt.name), "prompt", usedKeys);
      usedKeys.set(operationKey, ref);
      targets.push({ ref, operationKey, operation: prompt.description ? { description: prompt.description } : undefined });
    }

    return { targets, exhaustive: true };
  }
}

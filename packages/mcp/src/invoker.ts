import {
  ERR_RUNTIME,
  InvocationError,
  InvocationImpl,
  NoSourcesError,
  MultipleSourcesError,
  type BindingInvocationArgs,
  type BindingInvoker,
  type SynthesizeInput,
  type FormatInfo,
  type InterfaceSynthesizer,
  type Invocation,
  type OBInterface,
  type Source,
  type SourceInspection,
  type SourceInspector,
} from "@openbindings/sdk";
import { FORMAT_TOKEN } from "./constants.js";
import { runMCPBinding } from "./invoke.js";
import { discover, convertToInterface } from "./synthesize.js";

// ---------------------------------------------------------------------------
// Invoker
// ---------------------------------------------------------------------------

/** Invokes MCP bindings by connecting to MCP servers via Streamable HTTP. */
export class MCPInvoker implements BindingInvoker {
  formats(): FormatInfo[] {
    return [{ token: FORMAT_TOKEN, description: "MCP via Streamable HTTP" }];
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

/** Synthesizes OBInterface definitions by discovering an MCP server's capabilities. */
export class MCPSynthesizer implements InterfaceSynthesizer, SourceInspector {
  formats(): FormatInfo[] {
    return [{ token: FORMAT_TOKEN, description: "MCP via Streamable HTTP" }];
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

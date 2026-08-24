import { checkBindingSpecs as checkBindingSpecSupport } from "@openbindings/core";
import { type BindingSpecInfo, type BindingSpecVerdict, type OBInterface, type Source } from "@openbindings/core";
import {
  ERR_RUNTIME,
  InvocationError,
  InvocationImpl,
  type BindingInvocationArgs,
  type BindingInvoker,
  type Invocation,
} from "@openbindings/invoke";
import {
  MultipleSourcesError,
  finalizeSynthesis,
  finalizeSynthesisCoverage,
  synthesisSkeleton,
  type SynthesizeInput,
  type CoverageSynthesizer,
  type InterfaceSynthesizer,
  type SourceInspection,
  type SourceInspector,
  type SynthesizeResult,
} from "@openbindings/synthesize";
import { BINDING_SPEC, DEFAULT_SOURCE_NAME } from "./constants.js";
import { runMCPBinding, validateEndpoint } from "./invoke.js";
import {
  discover,
  convertToInterface,
  pinnedDiscovery,
  sanitizeKey,
  resolveKey,
  codePointCompare,
  bindableDiscovery,
  type MCPDiscovery,
} from "./synthesize.js";
import { mcpSynthesisCoverage } from "./coverage.js";

function mcpBindingSpecs(): BindingSpecInfo[] {
  return [{ bindingSpec: BINDING_SPEC, description: "MCP application-contract tools via Streamable HTTP" }];
}

function checkMCPBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
  return checkBindingSpecSupport(bindingSpecs, mcpBindingSpecs());
}

// ---------------------------------------------------------------------------
// Invoker
// ---------------------------------------------------------------------------

/** Constructor options for {@link MCPInvoker}. */
export interface MCPInvokerOptions {
  /**
   * Consumer-level value of this family's `solicit` configuration point
   * (openbindings.mcp@1 §9.3): whether a tools/call carries a progressToken
   * so the server's correlated progress notifications stream as output
   * values ahead of the result (§9.2). Mirrors the Go SDK's
   * WithSolicitProgress (invoker.go). The consultation order is
   * per-invocation context.configuration["solicit"] → this consumer-level
   * setting → the default, which is NOT solicited: without an opt-in the
   * output stream is the result value alone. Solicitation applies to tool
   * invocations only; undefined declines and falls through.
   */
  solicitProgress?: boolean;
}

/** Invokes MCP bindings by connecting to MCP servers via Streamable HTTP. */
export class MCPInvoker implements BindingInvoker {
  private readonly solicitProgress?: boolean;

  constructor(options?: MCPInvokerOptions) {
    this.solicitProgress = options?.solicitProgress;
  }

  checkBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
    return checkMCPBindingSpecs(bindingSpecs);
  }

  bindingSpecs(): BindingSpecInfo[] {
    return mcpBindingSpecs();
  }

  /**
   * Returns the invocation handle synchronously; the MCP session work is
   * scheduled asynchronously. The selector resolves against the listing before
   * dispatch (openbindings.mcp@1 §7): offline against a pinned listing when
   * the source carries content, otherwise against the live
   * capability-gated, pagination-exhausted listing (MCP-P-02). Tool
   * arguments, prompt arguments, and a resource template's variables arrive
   * as the operation's single input message through the handle's `write`
   * channel; static resource reads take no input (the binding closes the
   * input side once resolution says the selector names a static resource).
   * Progress notifications stream as outputs ahead of the result only when
   * solicited (§9.3's `solicit` configuration point — per-invocation
   * context.configuration.solicit, then the constructor's solicitProgress,
   * default off). Pre-dispatch failures (bad selector, missing endpoint, invalid
   * pin, invalid input, unresolvable selector) terminate the handle before the
   * entity request is sent.
   */
  invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
    const inv = new InvocationImpl<unknown, unknown>({ signal: args.signal });
    const opts = { solicitProgress: this.solicitProgress };
    queueMicrotask(() => {
      runMCPBinding(args, inv, opts).catch((err: unknown) => {
        inv.fireError(
          err instanceof InvocationError
            ? err
            : new InvocationError(ERR_RUNTIME),
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
export class MCPSynthesizer implements InterfaceSynthesizer, CoverageSynthesizer, SourceInspector {
  private readonly fetchImpl?: typeof globalThis.fetch;

  constructor(options?: MCPSynthesizerOptions) {
    this.fetchImpl = options?.fetch;
  }

  checkBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
    return checkMCPBindingSpecs(bindingSpecs);
  }

  bindingSpecs(): BindingSpecInfo[] {
    return mcpBindingSpecs();
  }

  /**
   * Converts an MCP server's capabilities to an OBInterface. A source
   * carrying content is a pinned listing (MCP-D-01): the pin is the
   * artifact (§6 content primacy), synthesis is offline, and the server is
   * never dialed — MCP-D-02 still requires the location (content does not
   * waive it), and an invalid pin is refused loudly before any I/O.
   * Without content, discovery connects live.
   */
  async synthesizeInterface(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<OBInterface> {
    return (await this.synthesizeObserved(input, options)).iface;
  }

  async synthesizeInterfaceWithCoverage(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<SynthesizeResult> {
    const observation = await this.synthesizeObserved(input, options);
    return finalizeSynthesisCoverage(
      observation.iface,
      mcpSynthesisCoverage(observation.discovery, observation.iface),
      true,
    );
  }

  private async synthesizeObserved(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<{ iface: OBInterface; discovery?: MCPDiscovery }> {
    const sources = input.sources ?? [];
    const src = sources.at(0);
    if (src === undefined) {
      return { iface: synthesisSkeleton(input) };
    }
    if (sources.length > 1) {
      throw new MultipleSourcesError();
    }
    if (src.bindingSpec !== BINDING_SPEC) throw new Error(`synthesizer supports exact binding specification ${JSON.stringify(BINDING_SPEC)}, got ${JSON.stringify(src.bindingSpec)}`);
    if (src.outputLocation) validateEndpoint(src.outputLocation);
    let disc: MCPDiscovery;
    if (src.content !== undefined) {
      validateEndpoint(src.location);
      disc = pinnedDiscovery(src.content);
    } else {
      if (!src.location) {
        throw new Error("MCP source requires a location (endpoint URL)");
      }
      disc = await discover(src.location, { signal: options?.signal, fetch: this.fetchImpl });
    }
    const iface = convertToInterface(disc, src.location, src.bindingSpec);
    if (src.content !== undefined) {
      const emittedSource = iface.sources?.[DEFAULT_SOURCE_NAME];
      if (emittedSource) emittedSource.content = src.content;
    } else if (src.embed) {
      if (disc.pinnedListing === undefined) {
        throw new Error("MCP live discovery did not yield a complete pagination-exhausted listing to embed");
      }
      const emittedSource = iface.sources?.[DEFAULT_SOURCE_NAME];
      if (emittedSource) emittedSource.content = disc.pinnedListing;
    }
    return {
      iface: finalizeSynthesis(iface, input, DEFAULT_SOURCE_NAME, src.bindingSpec),
      discovery: disc,
    };
  }

  /**
   * Lists all bindable targets (tools, resources, prompts). Each target's
   * operationKey is the same SanitizeKey + collision-resolved key
   * synthesizeInterface would assign it (one usedKeys map shared across all
   * four entity kinds, in the same tools/resources/resourceTemplates/prompts
   * order convertToInterface uses), so an inspection previews exactly what
   * synthesis names. A source carrying content is a pinned listing
   * (MCP-D-01): inspection reads the pin offline (§6 content primacy) and
   * the server is never dialed — MCP-D-02 still requires the location, and
   * an invalid pin is refused loudly before any I/O. Without content,
   * discovery connects live.
   */
  async inspectSource(
    source: Source,
    options?: { signal?: AbortSignal },
  ): Promise<SourceInspection> {
    let disc: MCPDiscovery;
    if (source.content !== undefined) {
      validateEndpoint(source.location);
      disc = pinnedDiscovery(source.content);
    } else {
      if (!source.location) throw new Error("MCP source requires a location (endpoint URL)");
      disc = await discover(source.location, { signal: options?.signal, fetch: this.fetchImpl });
    }
    disc = bindableDiscovery(disc, source.bindingSpec);
    const targets: SourceInspection["targets"] = [];
    const usedKeys = new Map<string, string>();

    for (const tool of disc.tools.sort((a, b) => codePointCompare(a.name, b.name))) {
      const selector = `tools/${tool.name}`;
      const operationKey = resolveKey(sanitizeKey(tool.name), "tool", usedKeys);
      usedKeys.set(operationKey, selector);
      targets.push({ selector, operationKey, operation: tool.description ? { description: tool.description } : undefined });
    }
    for (const res of disc.resources.sort((a, b) => codePointCompare(a.name, b.name))) {
      const selector = `resources/${res.uri}`;
      const operationKey = resolveKey(sanitizeKey(res.name), "resource", usedKeys);
      usedKeys.set(operationKey, selector);
      targets.push({ selector, operationKey, operation: res.description ? { description: res.description } : undefined });
    }
    for (const tmpl of disc.resourceTemplates.sort((a, b) => codePointCompare(a.name, b.name))) {
      const selector = `resourceTemplates/${tmpl.uriTemplate}`;
      const operationKey = resolveKey(sanitizeKey(tmpl.name), "resource_template", usedKeys);
      usedKeys.set(operationKey, selector);
      targets.push({ selector, operationKey, operation: tmpl.description ? { description: tmpl.description } : undefined });
    }
    for (const prompt of disc.prompts.sort((a, b) => codePointCompare(a.name, b.name))) {
      const selector = `prompts/${prompt.name}`;
      const operationKey = resolveKey(sanitizeKey(prompt.name), "prompt", usedKeys);
      usedKeys.set(operationKey, selector);
      targets.push({ selector, operationKey, operation: prompt.description ? { description: prompt.description } : undefined });
    }

    return { targets, exhaustive: true };
  }
}

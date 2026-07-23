import type { OBInterface, BindingEntry, JSONSchema, Operation } from "./types.js";
import type { InvokeHooks, InvokeSite, OutputDecoder, ResultClassifier, FieldRouter } from "./hooks.js";
import { MAX_TESTED_VERSION } from "./version.js";
import { validateInterface } from "./validate.js";

/** Identifies the binding source for invocation. */
export interface InvocationSource {
  bindingSpec: string;
  location?: string;
  content?: unknown;
}

/**
 * Arguments for invoking a resolved binding against a binding-spec-specific
 * source. Input messages are NOT part of the args — they flow through the
 * returned {@link Invocation} handle's `write` channel.
 *
 * Runtime prerequisites (credentials, configuration) travel in `context`
 * as opaque well-known fields; a binding that needs context it wasn't
 * given terminates with `CONTEXT_REQUIRED` before any side effect, and
 * resolution happens above the binding (see OperationInvoker's
 * contextResolver). Bindings depend on context data, never on a context
 * store or platform callbacks.
 */
export interface BindingInvocationArgs {
  source: InvocationSource;
  /** Format-specific pointer into the source artifact. Empty when the format doesn't use refs. */
  ref: string;
  /** The selected binding entry. Populated by the operation invoker; optional for direct calls. */
  binding?: BindingEntry;
  context?: Record<string, unknown>;
  /**
   * Bounds ONE DELIVERY UNIT — the bytes materialized to produce one
   * emitted output value. Undefined or `<= 0` selects the default
   * ({@link DEFAULT_MAX_DELIVERY_UNIT_BYTES}). Effectively-unlimited = set
   * explicitly huge (no magic sentinel). Format packages resolve it through
   * {@link resolveDeliveryUnitLimit}, never re-derive.
   */
  maxDeliveryUnitBytes?: number;
  /** The containing OBI. Most invokers do not need this; it is used by invokers that invoke sub-operations (e.g., operation graphs). */
  interface?: OBInterface;
  /** Operation input schema, populated by the operation invoker. Enables binding invokers to read schema metadata (e.g., const values). */
  inputSchema?: JSONSchema;
  /** External cancellation; converges with the handle's `cancel()`. */
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  /**
   * The consumer hook seam carrier (both tiers snapshotted). Populated by
   * the operation invoker; direct binding-layer callers who want different
   * hooks pass their own (OperationInvoker.snapshotHooks). Null/absent =
   * builtins only.
   */
  hooks?: InvokeHooks | null;
  /**
   * The consultation site (canonical operation key, binding key, format,
   * ref). Populated by the operation invoker; format invokers complete the
   * target where they know it.
   */
  site?: InvokeSite;
}

/**
 * The default delivery-unit bound: 10 MB per delivery unit (cross-SDK
 * parity: equals the Go SDK's `DefaultMaxDeliveryUnitBytes`, `10 << 20`).
 */
export const DEFAULT_MAX_DELIVERY_UNIT_BYTES = 10 * 1024 * 1024;

/**
 * Resolves the delivery-unit bound for one invocation: the args'
 * `maxDeliveryUnitBytes` when it is a positive finite number, else
 * {@link DEFAULT_MAX_DELIVERY_UNIT_BYTES}. The single semantics point for
 * the knob — format packages call this, never re-derive the rule.
 */
export function resolveDeliveryUnitLimit(
  args: Pick<BindingInvocationArgs, "maxDeliveryUnitBytes">,
): number {
  const v = args.maxDeliveryUnitBytes;
  // Undefined or <= 0 selects the default; non-finite values (NaN,
  // Infinity) do too — effectively-unlimited is an explicit huge number,
  // never a sentinel.
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_DELIVERY_UNIT_BYTES;
}

/**
 * Optional, per-call inputs to `OperationInvoker.invoke`. All fields are
 * usually omitted: invocation context is normally resolved by the invoker's
 * contextResolver via the reactive CONTEXT_REQUIRED path, and the binding is
 * normally selected by the operation-invoker contract's default policy. The
 * operation and interface are not here: the
 * operation comes from the {@link OperationSignature} and the interface is a
 * positional argument, so one signature works against any interface.
 */
export interface InvokeOptions {
  /** Per-call OB invocation-context override (credentials/config as opaque well-known fields). */
  context?: Record<string, unknown>;
  /** When set, bypass the binding selector and use this binding key directly. */
  bindingKey?: string;
  /** External cancellation; converges with the handle's `cancel()`. */
  signal?: AbortSignal;
  /**
   * Per-invocation consumer hooks (specification + configuration = complete
   * invocation): the top decline-chain tier, over the invoker-level hooks,
   * over the format built-in. Each axis declines independently.
   */
  outputDecoder?: OutputDecoder;
  resultClassifier?: ResultClassifier;
  fieldRouter?: FieldRouter;
}

/** Describes a binding source for interface synthesis. */
export interface SynthesizeSource {
  bindingSpec: string;
  name?: string;
  location?: string;
  content?: unknown;
  outputLocation?: string;
  embed?: boolean;
  description?: string;
}

/** Input for synthesizing an OpenBindings interface from binding-spec-specific sources. */
export interface SynthesizeInput {
  openbindingsVersion?: string;
  sources?: SynthesizeSource[];
  name?: string;
  version?: string;
  description?: string;
  /**
   * Invoked for a non-fatal, usable but lossy schema projection. A warning
   * must never stand in for omitting a callable target or returning an
   * operation that is statically guaranteed to refuse; those conditions fail
   * synthesis. Undefined is safe because the returned interface remains
   * sound. Mirrors the Go SDK's SynthesizeInput.OnWarning.
   */
  onWarning?: (warning: SynthesizerWarning) => void;
}

/** Deterministic source-less result required by the interface-synthesizer contract. */
export function synthesisSkeleton(input: SynthesizeInput = {}): OBInterface {
  const iface: OBInterface = {
    openbindings: input.openbindingsVersion ?? MAX_TESTED_VERSION,
    ...(input.name ? { name: input.name } : {}),
    ...(input.version ? { version: input.version } : {}),
    ...(input.description ? { description: input.description } : {}),
    operations: {},
  };
  validateInterface(iface);
  return iface;
}

/** Applies the format-neutral single-source authoring directives and validates the emitted OBI. */
export function finalizeSynthesis(
  iface: OBInterface,
  input: SynthesizeInput,
  defaultSourceName: string,
  bindingSpec: string,
): OBInterface {
  const [source] = input.sources ?? [];
  if (!source || (input.sources?.length ?? 0) !== 1) {
    throw new Error("finalize synthesis requires one source and one interface");
  }
  if (source.bindingSpec !== bindingSpec) {
    throw new Error(`synthesizer supports exact binding specification ${JSON.stringify(bindingSpec)}, got ${JSON.stringify(source.bindingSpec)}`);
  }
  if (input.openbindingsVersion) iface.openbindings = input.openbindingsVersion;
  if (input.name) iface.name = input.name;
  if (input.version) iface.version = input.version;
  if (input.description) iface.description = input.description;

  const entry = iface.sources?.[defaultSourceName];
  if (!entry) throw new Error(`synthesizer emitted no source ${JSON.stringify(defaultSourceName)}`);
  entry.bindingSpec = bindingSpec;
  if (source.outputLocation) entry.location = source.outputLocation;
  if (source.description) entry.description = source.description;
  const outputName = source.name || defaultSourceName;
  if (outputName !== defaultSourceName) {
    delete iface.sources![defaultSourceName];
    iface.sources![outputName] = entry;
    for (const binding of Object.values(iface.bindings ?? {})) {
      if (binding.source === defaultSourceName) binding.source = outputName;
    }
  }
  validateInterface(iface);
  return iface;
}

/**
 * A non-fatal, usable but lossy projection made while building an interface
 * from a source. Every returned operation remains bindable. Codes are stable
 * and binding-family-namespaced; `path` locates the affected member in dotted
 * notation. Mirrors the Go SDK's SynthesizerWarning.
 */
export interface SynthesizerWarning {
  code: string;
  message: string;
  path?: string;
}

/** Describes a binding specification supported by an invoker, by exact identifier. */
export interface BindingSpecInfo {
  bindingSpec: string;
  description?: string;
}

/** A target within a source document that can be framed as an OpenBindings operation. */
export interface BindableTarget {
  /** The reference string to use in a binding entry. */
  ref: string;
  /** Optional suggested operation key for this target. */
  operationKey?: string;
  /** Optional OpenBindings operation framing for this target. */
  operation?: Operation;
}

/** Result of inspecting a source document for bindable targets. */
export interface SourceInspection {
  /** The list of bindable targets discovered in the source. */
  targets: BindableTarget[];
  /**
   * True when this is the complete list of targets for the source.
   * When false, additional targets may exist that were not enumerated.
   */
  exhaustive: boolean;
}

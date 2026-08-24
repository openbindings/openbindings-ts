import type { OBInterface, BindingEntry, JSONSchema } from "@openbindings/core";
import type { InvokeHooks, InvokeSite, OutputDecoder, ResultClassifier, FieldRouter } from "./hooks.js";

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
  /** Format-specific pointer into the source artifact. Empty when the format doesn't use selectors. */
  selector: string;
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
   * selector). Populated by the operation invoker; format invokers complete the
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
 * selected automatically only when a sole invocable candidate remains. The
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

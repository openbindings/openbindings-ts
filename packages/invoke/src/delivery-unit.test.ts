import { describe, it, expect } from "vitest";
import {
  DEFAULT_MAX_DELIVERY_UNIT_BYTES,
  resolveDeliveryUnitLimit,
} from "./invoker-types.js";
import { OperationInvoker } from "./operation-invoker.js";
import { InvocationImpl } from "./invocation.js";
import type { BindingInvoker } from "./invokers.js";
import type { BindingInvocationArgs } from "./invoker-types.js";
import type { BindingSpecInfo } from "@openbindings/core";
import type { Invocation } from "./invocation.js";

// The ruled delivery-unit bound (sdk-review ruling 4(a), 2026-07-20): one
// exported shared default, one resolver as the single semantics point, and
// invoker-level stamping into per-invocation BindingInvocationArgs exactly
// where `fetch` is stamped. The default is asserted against the exact byte
// value so cross-SDK parity (Go's DefaultMaxDeliveryUnitBytes = 10 << 20)
// is testable, not conventional.

describe("DEFAULT_MAX_DELIVERY_UNIT_BYTES", () => {
  it("is exactly 10485760 (10 MB; equals the Go SDK's 10 << 20)", () => {
    expect(DEFAULT_MAX_DELIVERY_UNIT_BYTES).toBe(10485760);
  });
});

describe("resolveDeliveryUnitLimit", () => {
  it("returns the default when the field is undefined", () => {
    expect(resolveDeliveryUnitLimit({})).toBe(DEFAULT_MAX_DELIVERY_UNIT_BYTES);
  });

  it("returns the default for zero and negative values", () => {
    expect(resolveDeliveryUnitLimit({ maxDeliveryUnitBytes: 0 })).toBe(
      DEFAULT_MAX_DELIVERY_UNIT_BYTES,
    );
    expect(resolveDeliveryUnitLimit({ maxDeliveryUnitBytes: -1 })).toBe(
      DEFAULT_MAX_DELIVERY_UNIT_BYTES,
    );
  });

  it("returns the default for non-finite values (no magic sentinel)", () => {
    expect(resolveDeliveryUnitLimit({ maxDeliveryUnitBytes: Number.POSITIVE_INFINITY })).toBe(
      DEFAULT_MAX_DELIVERY_UNIT_BYTES,
    );
    expect(resolveDeliveryUnitLimit({ maxDeliveryUnitBytes: Number.NaN })).toBe(
      DEFAULT_MAX_DELIVERY_UNIT_BYTES,
    );
  });

  it("returns a positive value as given (effectively-unlimited = explicitly huge)", () => {
    expect(resolveDeliveryUnitLimit({ maxDeliveryUnitBytes: 1024 })).toBe(1024);
    expect(resolveDeliveryUnitLimit({ maxDeliveryUnitBytes: 1 << 30 })).toBe(1 << 30);
  });
});

/** A BindingInvoker that records the args it was invoked with. */
function capturingInvoker(): { invoker: BindingInvoker; seen: BindingInvocationArgs[] } {
  const seen: BindingInvocationArgs[] = [];
  const invoker: BindingInvoker = {
    checkBindingSpecs(bindingSpecs: readonly string[]) {
      return [...new Set(bindingSpecs)].map(bindingSpec => ({ bindingSpec, supported: bindingSpec === "test.spec@1" }));
    },
    bindingSpecs(): BindingSpecInfo[] {
      return [{ bindingSpec: "test.spec@1" }];
    },
    invokeBinding<I, O>(args: BindingInvocationArgs): Invocation<I, O> {
      seen.push(args);
      const inv = new InvocationImpl<unknown, unknown>({ signal: args.signal });
      queueMicrotask(() => {
        void inv.closeInput();
        inv.closeOutput();
      });
      return inv as Invocation<I, O>;
    },
  };
  return { invoker, seen };
}

describe("OperationInvoker delivery-unit stamping", () => {
  it("stamps OperationInvokerOptions.maxDeliveryUnitBytes into binding args like fetch", async () => {
    const { invoker, seen } = capturingInvoker();
    const op = new OperationInvoker([invoker], { maxDeliveryUnitBytes: 2048 });
    const call = op.invokeBinding({ source: { bindingSpec: "test.spec@1" }, selector: "" });
    await call.closed;
    expect(seen).toHaveLength(1);
    expect(seen[0]?.maxDeliveryUnitBytes).toBe(2048);
  });

  it("never overrides args that already carry a bound", async () => {
    const { invoker, seen } = capturingInvoker();
    const op = new OperationInvoker([invoker], { maxDeliveryUnitBytes: 2048 });
    const call = op.invokeBinding({
      source: { bindingSpec: "test.spec@1" },
      selector: "",
      maxDeliveryUnitBytes: 512,
    });
    await call.closed;
    expect(seen).toHaveLength(1);
    expect(seen[0]?.maxDeliveryUnitBytes).toBe(512);
  });

  it("leaves the field absent when the invoker has no bound (formats then default)", async () => {
    const { invoker, seen } = capturingInvoker();
    const op = new OperationInvoker([invoker]);
    const call = op.invokeBinding({ source: { bindingSpec: "test.spec@1" }, selector: "" });
    await call.closed;
    // Length asserted first so the optional chain cannot mask an empty array.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.maxDeliveryUnitBytes).toBeUndefined();
  });

  it("rides withRuntime copies", async () => {
    const { invoker, seen } = capturingInvoker();
    const op = new OperationInvoker([invoker], { maxDeliveryUnitBytes: 4096 }).withRuntime();
    const call = op.invokeBinding({ source: { bindingSpec: "test.spec@1" }, selector: "" });
    await call.closed;
    expect(seen).toHaveLength(1);
    expect(seen[0]?.maxDeliveryUnitBytes).toBe(4096);
  });
});

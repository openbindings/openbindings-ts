import { describe, expect, it, vi } from "vitest";
import type { OBInterface } from "@openbindings/core";
import { InvocationImpl } from "./invocation.js";
import { OperationInvoker } from "./operation-invoker.js";
import { HandlerBindingInvoker } from "./handler-binding-invoker.js";
import { ERR_TRANSFORM_ERROR } from "./errcodes.js";
import { InvocationError } from "./invocation.js";
import {
  ProviderDisposedError,
  RealizationNotFoundError,
  prepareProvider,
  type ProviderRuntime,
} from "./prepared-provider.js";

const IFACE: OBInterface = {
  openbindings: "0.2.0",
  operations: {
    deliver: { input: { type: "string" }, output: { type: "string" } },
  },
  sources: {
    local: { bindingSpec: "example.local@1", location: "app://delivery" },
    unsupported: { bindingSpec: "example.other@1", location: "app://other" },
  },
  bindings: {
    local: { operation: "deliver", source: "local", selector: "deliver" },
    unsupported: { operation: "deliver", source: "unsupported" },
  },
};

function runtime(): { engine: ProviderRuntime; compiled: ReturnType<typeof vi.fn> } {
  const compiled = vi.fn();
  const engine: ProviderRuntime = {
    bindingSpecs: () => [{ bindingSpec: "example.local@1" }],
    compileOperationHandle<I, O>() {
      compiled();
      return {
        invoke() {
          return new InvocationImpl<I, O>();
        },
        async preflight() {
          return null;
        },
      };
    },
  };
  return { engine, compiled };
}

describe("PreparedProvider", () => {
  it("indexes descriptors without eagerly compiling and closes each once", async () => {
    const { engine, compiled } = runtime();
    const provider = await prepareProvider({ key: "delivery", interface: IFACE, runtime: engine });

    expect(compiled).not.toHaveBeenCalled();
    expect(provider.realizationsForOperation("deliver")).toMatchObject([
      { bindingKey: "local", supported: true },
      { bindingKey: "unsupported", supported: false },
    ]);

    const first = provider.closeRealization("local");
    const second = provider.closeRealization("local");
    expect(second).toBe(first);
    expect(compiled).toHaveBeenCalledOnce();
    expect(first).toMatchObject({
      providerKey: "delivery",
      operationKey: "deliver",
      bindingKey: "local",
      sourceKey: "local",
      bindingSpec: "example.local@1",
      selector: "deliver",
    });
  });

  it("refuses bindings whose exact runtime capability is absent", async () => {
    const provider = await prepareProvider({ key: "delivery", interface: IFACE, runtime: runtime().engine });
    expect(() => provider.closeRealization("unsupported"))
      .toThrow(RealizationNotFoundError);
  });

  it("invalidates retained routes when its lifetime ends", async () => {
    const { engine } = runtime();
    const dispose = vi.fn();
    engine.dispose = dispose;
    const provider = await prepareProvider({ key: "delivery", interface: IFACE, runtime: engine });
    const realization = provider.closeRealization("local");

    await provider.dispose();
    await provider.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(() => realization.invoke()).toThrow(ProviderDisposedError);
    expect(() => provider.closeRealization("local")).toThrow(ProviderDisposedError);
  });

  it("refuses deterministic transform/runtime gaps during closure", async () => {
    const iface: OBInterface = structuredClone(IFACE);
    iface.bindings!.local!.inputTransform = "$";
    const binding = new HandlerBindingInvoker({ bindingSpec: "example.local@1" });
    binding.register({
      location: "app://delivery",
      selector: "deliver",
      handler: () => undefined,
    });
    const provider = await prepareProvider({
      key: "delivery",
      interface: iface,
      runtime: new OperationInvoker([binding]),
    });
    expect(() => provider.closeRealization("local")).toThrow(
      expect.objectContaining<Partial<InvocationError>>({ code: ERR_TRANSFORM_ERROR }),
    );
  });
});

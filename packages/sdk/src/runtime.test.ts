import { describe, expect, it } from "vitest";
import {
  InvocationImpl,
  single,
  type BindingInvocationArgs,
  type Invocation,
} from "@openbindings/invoke";
import {
  finalizeSynthesisCoverage,
  type SynthesizeInput,
} from "@openbindings/synthesize";
import type { BindingSpecVerdict, OBInterface, Source } from "@openbindings/core";
import { OpenBindingsRuntime, type BindingProvider } from "./runtime.js";

const bindingSpec = "example.binding@1";

function iface(): OBInterface {
  return {
    openbindings: "0.2.0",
    operations: { ping: {} },
    sources: { source: { bindingSpec, location: "memory://source" } },
    bindings: { "ping.binding": { operation: "ping", source: "source", selector: "target" } },
  };
}

class TestProvider implements BindingProvider {
  bindingSpecs() {
    return [{ bindingSpec, description: "test" }];
  }

  checkBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
    return [...new Set(bindingSpecs)].map((candidate) => ({
      bindingSpec: candidate,
      supported: candidate === bindingSpec,
    }));
  }

  invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
    const call = new InvocationImpl<unknown, unknown>({ signal: args.signal });
    queueMicrotask(async () => {
      await call.closeInput();
      await call.emitOutput({ ok: true });
      call.closeOutput();
    });
    return call as Invocation<I, O>;
  }

  async synthesizeInterface(_input: SynthesizeInput): Promise<OBInterface> {
    return iface();
  }

  async synthesizeInterfaceWithCoverage(input: SynthesizeInput) {
    return finalizeSynthesisCoverage(await this.synthesizeInterface(input), [{
      sourceIndex: 0,
      sourceKey: "source",
      sourceRef: "target",
      scope: "target",
      status: "represented",
      operationKey: "ping",
      bindingKey: "ping.binding",
      bindingSelector: "target",
    }], true);
  }

  async inspectSource(_source: Source) {
    return { targets: [{ selector: "target", operationKey: "ping" }], exhaustive: true };
  }
}

describe("OpenBindingsRuntime", () => {
  it("composes invocation, synthesis, coverage, and inspection from one provider", async () => {
    const runtime = new OpenBindingsRuntime({ providers: [new TestProvider()] });
    expect(runtime.bindingSpecs()).toEqual([{ bindingSpec, description: "test" }]);
    expect(runtime.supportsBindingSpec(bindingSpec)).toBe(true);
    expect(runtime.supportsBindingSpec("example.other@1")).toBe(false);
    await expect(runtime.inspectSource({ bindingSpec })).resolves.toEqual({
      targets: [{ selector: "target", operationKey: "ping" }],
      exhaustive: true,
    });
    const synthesis = await runtime.synthesizeInterfaceWithCoverage({ sources: [{ bindingSpec }] });
    expect(synthesis.coverage.exhaustive).toBe(true);
    expect(synthesis.coverage.entries).toHaveLength(1);
    await expect(runtime.prepareOperation(iface(), "ping")).resolves.toBeNull();
    expect(await single(runtime.invoke(iface(), "ping").outputs)).toEqual({ ok: true });
    expect(await single(runtime.invoke(iface(), { key: "ping" }).outputs)).toEqual({ ok: true });

    const provider = await runtime.prepareProvider("fixture", iface());
    expect(provider.realizationsForOperation("ping")).toMatchObject([
      { bindingKey: "ping.binding", supported: true },
    ]);
    expect(await single(provider.closeRealization("ping.binding").invoke().outputs)).toEqual({ ok: true });
  });

  it("resolves a non-OBI target through the same registered provider", async () => {
    const runtime = new OpenBindingsRuntime({
      providers: [new TestProvider()],
      fetch: async () => new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    const resolved = await runtime.resolve("https://api.example.test/openapi.json");
    expect(resolved.iface).toEqual(iface());
    expect(resolved.synthesized).toBe(true);
    expect(resolved.coverage?.exhaustive).toBe(true);
  });

  it("rejects duplicate exact binding-specification registrations", () => {
    expect(() => new OpenBindingsRuntime({
      providers: [new TestProvider(), new TestProvider()],
    })).toThrow(/registered by providers 0 and 1/u);
  });
});

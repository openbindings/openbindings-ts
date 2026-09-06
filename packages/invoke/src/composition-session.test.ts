import { describe, expect, it, vi } from "vitest";
import type { OBInterface } from "@openbindings/core";
import { prepareInterface } from "@openbindings/core";
import { InvocationImpl } from "./invocation.js";
import { CompositionSession } from "./composition-session.js";
import { referenceCompositionPolicy, type CompositionPolicy } from "./composition-policy.js";
import { prepareProvider, type ProviderRuntime } from "./prepared-provider.js";

const SPEC = "example.local@1";

function consumer(input: Record<string, unknown> = { type: "string" }): OBInterface {
  return {
    openbindings: "0.2.0",
    operations: { deliver: { input, output: { type: "string" } } },
    dependencies: { delivery: { operation: "deliver", bindingSpecs: [SPEC] } },
  };
}

function providerDocument(bindings = 1, input: Record<string, unknown> = { type: "string" }): OBInterface {
  return {
    openbindings: "0.2.0",
    operations: { deliver: { input, output: { type: "string" } } },
    sources: Object.fromEntries(Array.from({ length: bindings }, (_, index) => [
      `source${index}`,
      { bindingSpec: SPEC, location: `app://delivery/${index}` },
    ])),
    bindings: Object.fromEntries(Array.from({ length: bindings }, (_, index) => [
      `binding${index}`,
      { operation: "deliver", source: `source${index}` },
    ])),
  };
}

function testRuntime(options?: { failClosure?: boolean }) {
  const compiled = vi.fn();
  const preflight = vi.fn(async () => null);
  const runtime: ProviderRuntime = {
    bindingSpecs: () => [{ bindingSpec: SPEC }],
    compileOperationHandle<I, O>() {
      compiled();
      if (options?.failClosure) throw new Error("cannot close");
      return {
        invoke: () => new InvocationImpl<I, O>(),
        preflight,
      };
    },
  };
  return { runtime, compiled, preflight };
}

describe("CompositionSession", () => {
  it.each([
    undefined,
    { status: "selected" },
    { status: "selected", realization: { bindingKey: "unknown" } },
    { status: "invented" },
    { status: "ambiguous", realizations: [{ bindingKey: "unknown" }] },
  ])("rejects a malformed custom realization election %#", async result => {
    const engine = testRuntime();
    const provider = await prepareProvider({ key: "provider", interface: providerDocument(), runtime: engine.runtime });
    const policy = {
      ...referenceCompositionPolicy,
      selectRealization: () => result,
    } as unknown as CompositionPolicy;
    const session = new CompositionSession({ consumer: await prepareInterface(consumer()), providers: [{ provider }], policy });
    await expect(session.resolve("delivery")).rejects.toThrow(/composition policy/);
    expect(engine.compiled).not.toHaveBeenCalled();
  });
  it("resolves a verified route without performing live preflight", async () => {
    const required = await prepareInterface(consumer());
    const engine = testRuntime();
    const provider = await prepareProvider({
      key: "primary",
      interface: providerDocument(),
      runtime: engine.runtime,
    });
    const session = new CompositionSession({
      consumer: required,
      providers: [{ provider }],
    });

    const result = await session.resolve("delivery");
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.route).toMatchObject({
      dependencyKey: "delivery",
      requiredOperationKey: "deliver",
      providerKey: "primary",
      providerOperationKey: "deliver",
      bindingKey: "binding0",
      bindingSpec: SPEC,
    });
    expect(engine.compiled).toHaveBeenCalledOnce();
    expect(engine.preflight).not.toHaveBeenCalled();
    await result.route.preflight();
    expect(engine.preflight).toHaveBeenCalledOnce();
  });

  it("separates provider ambiguity from realization ambiguity", async () => {
    const required = await prepareInterface(consumer());
    const one = await prepareProvider({ key: "one", interface: providerDocument(), runtime: testRuntime().runtime });
    const two = await prepareProvider({ key: "two", interface: providerDocument(), runtime: testRuntime().runtime });
    const providerTie = await new CompositionSession({
      consumer: required,
      providers: [{ provider: one }, { provider: two }],
    }).resolve("delivery");
    expect(providerTie).toMatchObject({ status: "ambiguous", ambiguity: { stage: "provider" } });

    const many = await prepareProvider({
      key: "many",
      interface: providerDocument(2),
      runtime: testRuntime().runtime,
    });
    const bindingTie = await new CompositionSession({
      consumer: required,
      providers: [{ provider: many }],
    }).resolve("delivery");
    expect(bindingTie).toMatchObject({ status: "ambiguous", ambiguity: { stage: "realization" } });
  });

  it("uses the unique highest provider and its explicit realization selector", async () => {
    const required = await prepareInterface(consumer());
    const low = await prepareProvider({ key: "low", interface: providerDocument(), runtime: testRuntime().runtime });
    const high = await prepareProvider({
      key: "high",
      interface: providerDocument(2),
      runtime: testRuntime().runtime,
      selectRealization: () => "binding1",
    });
    const result = await new CompositionSession({
      consumer: required,
      providers: [
        { provider: low, preference: 0 },
        { provider: high, preference: 10 },
      ],
    }).resolve("delivery");
    expect(result).toMatchObject({
      status: "available",
      route: { providerKey: "high", bindingKey: "binding1" },
    });
  });

  it("does not inspect a lower preference tier after a higher tier resolves", async () => {
    const required = await prepareInterface(consumer());
    const high = await prepareProvider({
      key: "high",
      interface: { ...providerDocument(), name: "high" },
      runtime: testRuntime().runtime,
    });
    const low = await prepareProvider({
      key: "low",
      interface: { ...providerDocument(), name: "low" },
      runtime: testRuntime().runtime,
    });
    let lowInspections = 0;
    const policy = {
      ...referenceCompositionPolicy,
      async assessContract(...args: Parameters<typeof referenceCompositionPolicy.assessContract>) {
        if (args[2].interfaceSnapshot.name === "low") lowInspections++;
        return referenceCompositionPolicy.assessContract(...args);
      },
    };

    const result = await new CompositionSession({
      consumer: required,
      providers: [
        { provider: low, preference: 0 },
        { provider: high, preference: 10 },
      ],
      policy,
    }).resolve("delivery");

    expect(result).toMatchObject({ status: "available", route: { providerKey: "high" } });
    expect(lowInspections).toBe(0);
  });

  it("preserves indeterminate evidence in a conservative unavailable result", async () => {
    const required = await prepareInterface(consumer({ type: "string", pattern: "^[a-z]+$" }));
    const provider = await prepareProvider({
      key: "pattern",
      interface: providerDocument(1, { type: "string", pattern: "^[A-Z]+$" }),
      runtime: testRuntime().runtime,
    });
    const result = await new CompositionSession({
      consumer: required,
      providers: [{ provider }],
    }).resolve("delivery");
    expect(result).toMatchObject({
      status: "unavailable",
      assessments: [{ code: "contract_indeterminate", providerKey: "pattern" }],
    });
  });

  it("does not fall back after the selected provider fails deterministic closure", async () => {
    const required = await prepareInterface(consumer());
    const high = await prepareProvider({
      key: "high",
      interface: providerDocument(),
      runtime: testRuntime({ failClosure: true }).runtime,
    });
    const lowEngine = testRuntime();
    const low = await prepareProvider({
      key: "low",
      interface: providerDocument(),
      runtime: lowEngine.runtime,
    });
    const result = await new CompositionSession({
      consumer: required,
      providers: [
        { provider: high, preference: 10 },
        { provider: low, preference: 0 },
      ],
    }).resolve("delivery");
    expect(result).toMatchObject({
      status: "unavailable",
      assessments: expect.arrayContaining([
        expect.objectContaining({ code: "realization_closure_failed", providerKey: "high" }),
      ]),
    });
    expect(lowEngine.compiled).not.toHaveBeenCalled();
  });

  it("returns serializable diagnostics without raw provider objects", async () => {
    const required = await prepareInterface(consumer());
    const unsupportedRuntime: ProviderRuntime = {
      bindingSpecs: () => [],
      compileOperationHandle() {
        throw new Error("unreachable");
      },
    };
    const provider = await prepareProvider({
      key: "unsupported",
      interface: providerDocument(),
      runtime: unsupportedRuntime,
    });
    const inspection = await new CompositionSession({
      consumer: required,
      providers: [{ provider }],
    }).inspect("delivery");
    expect(inspection.assessments).toEqual([
      expect.objectContaining({ code: "binding_spec_unsupported", providerKey: "unsupported" }),
    ]);
    expect(() => JSON.stringify(inspection)).not.toThrow();
    expect(JSON.stringify(inspection)).not.toContain("#state");
  });

  it("cancels promptly while an application policy comparison is still pending", async () => {
    const required = await prepareInterface(consumer());
    const provider = await prepareProvider({
      key: "slow",
      interface: providerDocument(),
      runtime: testRuntime().runtime,
    });
    let release!: () => void;
    const stalled = new Promise<void>(resolve => {
      release = resolve;
    });
    const policy = {
      ...referenceCompositionPolicy,
      async assessContract(...args: Parameters<typeof referenceCompositionPolicy.assessContract>) {
        await stalled;
        return referenceCompositionPolicy.assessContract(...args);
      },
    };
    const controller = new AbortController();
    const pending = new CompositionSession({
      consumer: required,
      providers: [{ provider }],
      policy,
    }).resolve("delivery", { signal: controller.signal });

    controller.abort(new DOMException("superseded", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    release();
  });
});

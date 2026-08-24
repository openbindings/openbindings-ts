import { describe, expect, it } from "vitest";
import {
  InvokeHooks,
  USE_DEFAULT,
  assumptionWarning,
  classifyThroughHooks,
  decodeThroughHooks,
  floorStamped,
  newInvokeHooks,
  nonDiscriminatingOutput,
  type InvokeSite,
  type RawResult,
} from "./hooks.js";
import { InvocationError } from "./invocation.js";
import { ERR_EXECUTION_FAILED, ERR_RESPONSE_ERROR, ERR_RUNTIME, ERR_STREAM_ERROR } from "./errcodes.js";
import { OperationInvoker } from "./operation-invoker.js";

const site: InvokeSite = {
  operation: "com.example.op",
  invokedAs: "op",
  bindingKey: "op.usage",
  bindingSpec: "usage@2.13.1",
  selector: "check",
  target: "example",
};

const raw: RawResult = { status: 1, body: "out", meta: {} };

describe("the decline chain", () => {
  it("per-invocation wins; declines chain tier by tier to the builtin", async () => {
    const builtin = () => "builtin";

    let h = new InvokeHooks(
      { decode: () => "per-inv" },
      { decode: () => "invoker" },
    );
    expect(await h.decodeOutput(site, raw, builtin)).toBe("per-inv");
    expect(h.decodeDecidedBy()).toBe("hook");

    // Per-invocation declines: falls to invoker-level, NOT straight to the
    // builtin (the winner-takes-slot hazard).
    h = new InvokeHooks(
      { decode: () => USE_DEFAULT },
      { decode: () => "invoker" },
    );
    expect(await h.decodeOutput(site, raw, builtin)).toBe("invoker");

    h = new InvokeHooks(
      { decode: () => USE_DEFAULT },
      { decode: () => USE_DEFAULT },
    );
    expect(await h.decodeOutput(site, raw, builtin)).toBe("builtin");
    expect(h.decodeDecidedBy()).toBe("builtin");
  });

  it("a null carrier runs the builtin (the module helpers are null-safe)", async () => {
    expect(await decodeThroughHooks(null, site, raw, () => "builtin")).toBe("builtin");
    expect(await classifyThroughHooks(null, site, raw, (_s, r) => r.status === 0)).toBe(false);
  });

  it("newInvokeHooks returns null when both tiers are empty", () => {
    expect(newInvokeHooks({}, {})).toBeNull();
    expect(newInvokeHooks({ decode: () => 1 }, {})).not.toBeNull();
  });

  it("the route chain declines with empty string", () => {
    const h = new InvokeHooks(
      { route: (_s, field) => (field === "locator" ? "stdin-dash" : "") },
      { route: (_s, field) => (field === "config" ? "file" : "") },
    );
    expect(h.routeField(site, "locator", null)).toBe("stdin-dash");
    expect(h.routeField(site, "config", null)).toBe("file");
    expect(h.routeField(site, "other", null)).toBe("");
  });
});

describe("failure channels", () => {
  it("a thrown InvocationError passes through with its code and portable data only", async () => {
    const h = new InvokeHooks(
      {
        decode: () => {
          throw new InvocationError(ERR_STREAM_ERROR);
        },
      },
      {},
    );
    const err = await h.decodeOutput(site, raw, null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvocationError);
    expect((err as InvocationError).code).toBe(ERR_STREAM_ERROR);
    expect(Object.hasOwn(err as object, "diagnostics")).toBe(false);
  });

  it("a thrown plain error is a deliberate terminal with the axis's native code", async () => {
    const hd = new InvokeHooks(
      {
        decode: () => {
          throw new Error("not orderml");
        },
      },
      {},
    );
    const derr = await hd.decodeOutput(site, raw, null).catch((e: unknown) => e);
    expect((derr as InvocationError).code).toBe(ERR_RESPONSE_ERROR);

    const hc = new InvokeHooks(
      {
        classify: () => {
          throw new Error("bad state");
        },
      },
      {},
    );
    const cerr = await hc.classify(site, raw, null).catch((e: unknown) => e);
    expect((cerr as InvocationError).code).toBe(ERR_EXECUTION_FAILED);
  });

  it("an all-decline chain with no builtin is a loud ERR_RUNTIME, never a silent value", async () => {
    const err = await decodeThroughHooks(null, site, raw, null).catch((e: unknown) => e);
    expect((err as InvocationError).code).toBe(ERR_RUNTIME);

    // A builtin returning USE_DEFAULT is a format bug — loud too.
    const err2 = await decodeThroughHooks(null, site, raw, () => USE_DEFAULT).catch(
      (e: unknown) => e,
    );
    expect((err2 as InvocationError).code).toBe(ERR_RUNTIME);
  });
});

describe("snapshot composition (the direct binding-layer affordance)", () => {
  it("snapshotHooks composes per-invocation over invoker-level", async () => {
    const inv = new OperationInvoker([]);
    inv.outputDecoder = () => "invoker";
    inv.resultClassifier = () => true;

    const h = inv.snapshotHooks(() => "per-inv");
    expect(h).not.toBeNull();
    expect(await h!.decodeOutput(site, raw, null)).toBe("per-inv");
    // Nil per-invocation classify declines to the invoker-level one.
    expect(await h!.classify(site, raw, null)).toBe(true);
    expect(h!.classifyDecidedBy()).toBe("hook");
  });

  it("withRuntime carries the hook fields", () => {
    const inv = new OperationInvoker([]);
    inv.resultClassifier = () => true;
    const cp = inv.withRuntime();
    expect(cp.resultClassifier).toBeDefined();
  });

  it("the snapshot is immune to later field mutation", async () => {
    const inv = new OperationInvoker([]);
    inv.outputDecoder = () => "captured";
    const h = inv.snapshotHooks();
    inv.outputDecoder = () => "mutated";
    expect(await h!.decodeOutput(site, raw, null)).toBe("captured");
  });
});

describe("contract inspectors + the the conventions record warning", () => {
  const floor = { type: "string", "x-ob": { floor: "text" } };

  it("floorStamped and nonDiscriminatingOutput read the contract", () => {
    expect(floorStamped(floor)).toBe(true);
    expect(floorStamped({ type: "string" })).toBe(false);
    expect(nonDiscriminatingOutput(undefined)).toBe(true);
    expect(nonDiscriminatingOutput({ type: "string" })).toBe(true);
    expect(nonDiscriminatingOutput({ type: "object", required: ["id"] })).toBe(false);
  });

  it("the warning fires only for an assumption-decoded, undiscriminating contract", () => {
    expect(assumptionWarning("assumption/text", floor)).toContain("floor-stamped");
    expect(assumptionWarning("assumption/text", undefined)).toContain("no output schema");
    expect(assumptionWarning("assumption/text", { type: "object", required: ["id"] })).toBe("");
    // A hook decode, a wire-framed lane, or no decode at all silences it.
    expect(assumptionWarning("hook", floor)).toBe("");
    expect(assumptionWarning("header/content-type", undefined)).toBe("");
    expect(assumptionWarning("spec/content-type", undefined)).toBe("");
    expect(assumptionWarning("", undefined)).toBe("");
  });
});

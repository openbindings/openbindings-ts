import { expect, it } from "vitest";
import { createJSONataExecutor } from "@openbindings/jsonata";
import { createJSONataEvaluator } from "./jsonata.js";
import type { OBInterface } from "@openbindings/core";
import { OperationInvoker } from "./operation-invoker.js";
import { HandlerBindingInvoker } from "./handler-binding-invoker.js";
import { InvocationImpl, InvocationError, contextRequiredError, type Invocation } from "./invocation.js";
import type { BindingInvoker, TransformEvaluator } from "./invokers.js";
import type { BindingInvocationArgs } from "./invoker-types.js";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function untilAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
function fixture(direction: "input" | "output"): OBInterface {
  return {
    openbindings: "0.2.0", operations: { test: {} },
    sources: { test: { bindingSpec: "test.cancellation@1", location: "local:test" } },
    bindings: { test: { operation: "test", source: "test", selector: "echo", [direction + "Transform"]: "$" } },
  };
}
function binding(): HandlerBindingInvoker {
  const invoker = new HandlerBindingInvoker({ bindingSpec: "test.cancellation@1" });
  invoker.register({ location: "local:test", selector: "echo", handler: async handle => {
    for await (const value of handle.inputs()) await handle.emitOutput(value);
    handle.closeOutput();
  } });
  return invoker;
}

for (const prepared of [false, true]) {
  for (const direction of ["input", "output"] as const) {
    it(`cancellation reaches ${direction} evaluator; prepared=${prepared}`, async () => {
      const entered = latch(), stopped = latch();
      const evaluator: TransformEvaluator = { async evaluate(_expr, data, options) {
        expect(options?.signal).toBeInstanceOf(AbortSignal);
        entered.resolve();
        await untilAbort(options!.signal!);
        stopped.resolve();
        // Even a non-cooperating adapter returning a value after abort cannot
        // leak it across the SDK boundary.
        return data;
      } };
      const op = new OperationInvoker([binding()], { transformEvaluator: evaluator });
      const call = prepared
        ? (await op.prepareOperationHandle(fixture(direction), { key: "test" })).invoke()
        : op.invoke(fixture(direction), { key: "test" });
      const closed = call.closed.catch(error => error);
      const write = call.write({ id: 1 }).catch(error => error);
      try {
        await entered.promise;
        await call.cancel();
        expect(await closed).toMatchObject({ code: "ERR_CANCELLED" });
        await stopped.promise;
        await write;
        await expect(call.outputs[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "ERR_CANCELLED" });
      } finally { await call.cancel(); }
    });
  }
}

it("pre-cancel never starts an evaluator", async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const op = new OperationInvoker([binding()], { transformEvaluator: { async evaluate(_expr, value) { calls++; return value; } } });
  const call = op.invoke(fixture("input"), { key: "test" }, { signal: controller.signal });
  await expect(call.closed).rejects.toMatchObject({ code: "ERR_CANCELLED" });
  expect(calls).toBe(0);
});

it("concurrent invocations have independent evaluator signals", async () => {
  const entered = latch(), stopped = latch();
  const evaluator: TransformEvaluator = { async evaluate(_expr, value, options) {
    if (value === "slow") { entered.resolve(); await untilAbort(options!.signal!); stopped.resolve(); }
    return value;
  } };
  const op = new OperationInvoker([binding()], { transformEvaluator: evaluator });
  const a = op.invoke(fixture("input"), { key: "test" });
  const b = op.invoke(fixture("input"), { key: "test" });
  const aClosed = a.closed.catch(error => error);
  const aWrite = a.write("slow").catch(error => error);
  try {
    await entered.promise; await a.cancel(); await stopped.promise;
    await b.write("unrelated"); await b.close();
    const outputs = []; for await (const v of b.outputs) outputs.push(v);
    expect(outputs).toEqual(["unrelated"]);
    await b.closed; await aWrite;
    expect(await aClosed).toMatchObject({ code: "ERR_CANCELLED" });
  } finally { await a.cancel(); await b.cancel(); }
});

it("a binding terminal retires an in-flight input transform: the terminal surfaces, not a transform error, and nothing is retried", async () => {
  const entered = latch(), stopped = latch();
  const details = { target: "test", alternatives: [{ requirements: [{ type: "auth.bearer" }] }] };
  let attempts = 0, evaluations = 0;
  const mock: BindingInvoker = {
    bindingSpecs: () => [{ bindingSpec: "test.cancellation@1" }],
    checkBindingSpecs: specs => specs.map(bindingSpec => ({ bindingSpec, supported: true })),
    invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
      const inner = new InvocationImpl<unknown, unknown>({ signal: args.signal });
      attempts++;
      void (async () => {
        // Challenge live, while the operation layer is still transforming
        // the caller's first input for this attempt.
        await entered.promise;
        inner.fireError(contextRequiredError(details));
      })().catch(() => { /* terminal cleanup */ });
      return inner as Invocation<I, O>;
    },
  };
  const resolutions: unknown[] = [];
  const op = new OperationInvoker([mock], {
    contextResolver: async d => { resolutions.push(d); return { bearerToken: "test-only" }; },
    transformEvaluator: { async evaluate(_expr, _value, options) {
      evaluations++;
      entered.resolve(); await untilAbort(options!.signal!); stopped.resolve();
      throw new Error("retired attempt");
    } },
  });
  const call = op.invoke(fixture("input"), { key: "test" });
  const closed = call.closed.catch(error => error);
  try {
    await call.write("raw"); await call.close();
    const outputs = call.outputs[Symbol.asyncIterator]();
    const read = await outputs.next().catch(error => error);
    await stopped.promise;
    expect(read).toMatchObject({ code: "CONTEXT_REQUIRED", data: details });
    expect(await closed).toMatchObject({ code: "CONTEXT_REQUIRED", data: details });
    // One attempt, one evaluation (retired through its signal), and the
    // resolver was never consulted for the live challenge.
    expect(attempts).toBe(1); expect(evaluations).toBe(1);
    expect(resolutions).toEqual([]);
  } finally { await call.cancel(); }
});

it("a genuine transform failure retains its terminal after a late cancellation", async () => {
  const op = new OperationInvoker([binding()], { transformEvaluator: { async evaluate() { throw new Error("bad transform"); } } });
  const call = op.invoke(fixture("input"), { key: "test" });
  const closed = call.closed.catch(error => error);
  await call.write("input").catch(() => undefined);
  expect(await closed).toBeInstanceOf(InvocationError);
  await call.cancel();
  expect(await closed).toMatchObject({ code: "ERR_TRANSFORM_ERROR" });
});

// The candidate runtime is loaded only by this qualification test; the SDK
// remains dependency-injected and no published default is switched here.
const officialEvaluator = createJSONataEvaluator(createJSONataExecutor({ timeout: 1000 }));

for (const direction of ["input", "output"] as const) {
  it(`real JSONata ${direction} evaluation stops through the SDK on a timer-driven cancellation`, async () => {
    const entered = latch(), stopped = latch();
    let nativeError: unknown;
    const op = new OperationInvoker([binding()], { transformEvaluator: { async evaluate(_expr, data, options) {
      entered.resolve();
      try { return await officialEvaluator.evaluate("($f := function($n){$f($n+1)}; $f(0))", data, options); }
      catch (error) { nativeError = error; throw error; }
      finally { stopped.resolve(); }
    } } });
    const call = op.invoke(fixture(direction), { key: "test" });
    const closed = call.closed.catch(error => error);
    const write = call.write({ id: 1 }).catch(error => error);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await entered.promise;
      timer = setTimeout(() => { void call.cancel(); }, 5);
      await stopped.promise;
      expect(nativeError).toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
      expect(await closed).toMatchObject({ code: "ERR_CANCELLED" });
      await write;
    } finally { clearTimeout(timer); await call.cancel(); }
  });
}

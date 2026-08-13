/**
 * Phase-1 acceptance: the conformance test matrix for the reference
 * InvocationImpl and the `single` terminal (operation-invoker-design.md).
 * Cardinality tags: U unary, SS server-streaming, CS client-streaming,
 * BD bidi, NI no-input.
 */
import { getEventListeners } from "node:events";
import { describe, it, expect } from "vitest";
import {
  InvocationImpl,
  InvocationError,
  single,
  OUTPUT_BUFFER_CAPACITY,
} from "./invocation.js";
import {
  CONTEXT_REQUIRED,
  ERR_ALREADY_CONSUMED,
  ERR_CANCELLED,
  ERR_EXPECTED_SINGLE,
  ERR_INPUT_CLOSED,
  ERR_INVOCATION_CLOSED,
  ERR_VALIDATION_FAILED,
} from "./errcodes.js";

const tick = (): Promise<void> => new Promise((res) => setTimeout(res, 0));

/** Resolves "pending" if p has not settled within two macrotasks. */
async function settledState(p: Promise<unknown>): Promise<"resolved" | "rejected" | "pending"> {
  const sentinel = Symbol("pending");
  const winner = await Promise.race([
    p.then(() => "resolved" as const, () => "rejected" as const),
    tick().then(() => tick()).then(() => sentinel),
  ]);
  if (winner === sentinel) return "pending";
  return winner as "resolved" | "rejected";
}

async function collect<O>(it: AsyncIterable<O>): Promise<O[]> {
  const out: O[] = [];
  for await (const v of it) out.push(v);
  return out;
}

function errCode(err: unknown): string {
  expect(err).toBeInstanceOf(InvocationError);
  return (err as InvocationError).code;
}

describe("lifecycle & ordering", () => {
  it("drains queued outputs before a terminal error (emit; emit; fireError in one tick) [SS]", async () => {
    const inv = new InvocationImpl<never, number>();
    void inv.emitOutput(1);
    void inv.emitOutput(2);
    inv.fireError(new InvocationError("ERR_STREAM_ERROR"));

    const seen: number[] = [];
    let caught: unknown;
    try {
      for await (const v of inv.outputs) seen.push(v);
    } catch (err) {
      caught = err;
    }
    expect(seen).toEqual([1, 2]);
    expect(errCode(caught)).toBe("ERR_STREAM_ERROR");
  });

  it("delivers outputs emitted before the caller acquires the sequence [U, NI]", async () => {
    const inv = new InvocationImpl<never, string>();
    await inv.emitOutput("early");
    inv.closeOutput();

    expect(await collect(inv.outputs)).toEqual(["early"]);
    await expect(inv.closed).resolves.toBeUndefined();
  });

  it("terminal is sticky and single: double-fire and post-close transitions are no-ops", async () => {
    const inv = new InvocationImpl<never, never>();
    inv.closeOutput();
    inv.fireError(new InvocationError("ERR_RUNTIME")); // no-op
    await inv.cancel(); // no-op
    await expect(inv.closed).resolves.toBeUndefined();

    const inv2 = new InvocationImpl<never, never>();
    inv2.fireError(new InvocationError("ERR_RUNTIME"));
    inv2.fireError(new InvocationError("ERR_RUNTIME")); // no-op
    inv2.closeOutput(); // no-op
    await expect(inv2.closed).rejects.toMatchObject({ code: "ERR_RUNTIME" });
  });

  it("cancel() after a real terminal error does not overwrite it (load-bearing for single)", async () => {
    const inv = new InvocationImpl<never, never>();
    const real = new InvocationError("ERR_EXECUTION_FAILED");
    inv.fireError(real);
    await inv.cancel();
    await expect(inv.closed).rejects.toBe(real);
  });
});

describe("single-consumer (acquire-once)", () => {
  it("second acquisition fails eagerly with ERR_ALREADY_CONSUMED", () => {
    const inv = new InvocationImpl<never, number>();
    inv.outputs[Symbol.asyncIterator]();
    expect(() => inv.outputs[Symbol.asyncIterator]()).toThrowError(
      expect.objectContaining({ code: ERR_ALREADY_CONSUMED }),
    );
  });

  it("single after a loop fails loudly, never splits [U, SS]", async () => {
    const inv = new InvocationImpl<never, number>();
    await inv.emitOutput(1);
    inv.closeOutput();
    await collect(inv.outputs);
    await expect(single(inv.outputs)).rejects.toMatchObject({ code: ERR_ALREADY_CONSUMED });
  });

  it("concurrent inputs() readers fail loudly [BD]", async () => {
    const inv = new InvocationImpl<number, never>();
    const itA = inv.inputs()[Symbol.asyncIterator]();
    const itB = inv.inputs()[Symbol.asyncIterator]();
    const a = itA.next(); // parks (no input yet)
    await expect(itB.next()).rejects.toMatchObject({ code: ERR_ALREADY_CONSUMED });
    await inv.close();
    await expect(a).resolves.toEqual({ value: undefined, done: true });
  });
});

describe("single", () => {
  it("returns the one output [U]", async () => {
    const inv = new InvocationImpl<never, string>();
    await inv.emitOutput("only");
    inv.closeOutput();
    await expect(single(inv.outputs)).resolves.toBe("only");
  });

  it("errors ERR_EXPECTED_SINGLE on zero outputs", async () => {
    const inv = new InvocationImpl<never, string>();
    inv.closeOutput();
    await expect(single(inv.outputs)).rejects.toMatchObject({
      code: ERR_EXPECTED_SINGLE,
    });
  });

  it("short-circuits on the second output, cancelling cleanly [SS — the critical misuse case]", async () => {
    const inv = new InvocationImpl<never, number>();
    await inv.emitOutput(1);
    await inv.emitOutput(2);
    // The binding keeps streaming; single must NOT buffer the whole stream.
    const p = single(inv.outputs);
    await expect(p).rejects.toMatchObject({
      code: ERR_EXPECTED_SINGLE,
    });
    // Abandoning the sequence cancelled the invocation: the binding's
    // signal aborted and the handle is terminal.
    expect(inv.signal.aborted).toBe(true);
    await expect(inv.closed).rejects.toMatchObject({ code: ERR_CANCELLED });
  });

  it("surfaces a terminal error after the first output, not a false 'got more' [SS]", async () => {
    const inv = new InvocationImpl<never, number>();
    await inv.emitOutput(1);
    inv.fireError(new InvocationError("ERR_STREAM_ERROR"));
    await expect(single(inv.outputs)).rejects.toMatchObject({ code: "ERR_STREAM_ERROR" });
  });
});

describe("backpressure (bounded-block)", () => {
  it("emitOutput parks at capacity and wakes on drain, preserving order [SS]", async () => {
    const inv = new InvocationImpl<never, number>();
    for (let i = 0; i < OUTPUT_BUFFER_CAPACITY; i++) {
      await inv.emitOutput(i);
    }
    let parkedResolved = false;
    const parked = inv.emitOutput(99).then(() => { parkedResolved = true; });
    expect(await settledState(parked)).toBe("pending");
    expect(parkedResolved).toBe(false);

    // Drain one: the parked producer is admitted.
    const it = inv.outputs[Symbol.asyncIterator]();
    await expect(it.next()).resolves.toEqual({ value: 0, done: false });
    await parked;
    inv.closeOutput();

    const rest: number[] = [];
    for (;;) {
      const r = await it.next();
      if (r.done) break;
      rest.push(r.value);
    }
    // Exact order: the remaining buffered values, then the parked value.
    expect(rest).toEqual([...Array.from({ length: OUTPUT_BUFFER_CAPACITY - 1 }, (_, i) => i + 1), 99]);
  });

  it("a producer parked on a full buffer rejects on terminal instead of stranding [SS, BD]", async () => {
    const inv = new InvocationImpl<never, number>();
    for (let i = 0; i < OUTPUT_BUFFER_CAPACITY; i++) await inv.emitOutput(i);
    const parked = inv.emitOutput(99);
    inv.fireError(new InvocationError("ERR_STREAM_ERROR"));
    await expect(parked).rejects.toMatchObject({ code: "ERR_STREAM_ERROR" });
  });

  it("a producer parked at closeOutput rejects ERR_INVOCATION_CLOSED", async () => {
    const inv = new InvocationImpl<never, number>();
    for (let i = 0; i < OUTPUT_BUFFER_CAPACITY; i++) await inv.emitOutput(i);
    const parked = inv.emitOutput(99);
    inv.closeOutput();
    await expect(parked).rejects.toMatchObject({ code: ERR_INVOCATION_CLOSED });
  });

  it("write parks at input capacity and wakes when the binding reads [CS]", async () => {
    const inv = new InvocationImpl<number, never>();
    await inv.write(1); // fills capacity-1 buffer
    const parked = inv.write(2);
    expect(await settledState(parked)).toBe("pending");

    const it = inv.inputs()[Symbol.asyncIterator]();
    await expect(it.next()).resolves.toEqual({ value: 1, done: false });
    await parked; // admitted
    await expect(it.next()).resolves.toEqual({ value: 2, done: false });
  });

  it("a parked write rejects on terminal [CS]", async () => {
    const inv = new InvocationImpl<number, never>();
    await inv.write(1);
    const parked = inv.write(2);
    inv.fireError(new InvocationError("ERR_RUNTIME"));
    await expect(parked).rejects.toMatchObject({ code: "ERR_RUNTIME" });
  });

  it("end-to-end: a slow consumer flow-controls the binding's emit loop [SS]", async () => {
    const inv = new InvocationImpl<never, number>();
    let emitted = 0;
    const binding = (async () => {
      for (let i = 0; i < OUTPUT_BUFFER_CAPACITY + 5; i++) {
        await inv.emitOutput(i);
        emitted++;
      }
      inv.closeOutput();
    })();
    await tick();
    // Binding cannot run ahead of the buffer.
    expect(emitted).toBeLessThanOrEqual(OUTPUT_BUFFER_CAPACITY);
    const all = await collect(inv.outputs);
    await binding;
    expect(all).toEqual(Array.from({ length: OUTPUT_BUFFER_CAPACITY + 5 }, (_, i) => i));
  });
});

describe("input side", () => {
  it("caller close() ends the binding's input loop cleanly [CS]", async () => {
    const inv = new InvocationImpl<string, never>();
    await inv.write("a");
    const seen: string[] = [];
    const loop = (async () => {
      for await (const v of inv.inputs()) seen.push(v);
    })();
    await inv.write("b");
    await inv.close();
    await loop; // exits cleanly, no throw
    expect(seen).toEqual(["a", "b"]);
  });

  it("fireError makes the binding's parked input read THROW (vs clean exit on close)", async () => {
    const inv = new InvocationImpl<string, never>();
    const it = inv.inputs()[Symbol.asyncIterator]();
    const parked = it.next();
    inv.fireError(new InvocationError("ERR_RUNTIME"));
    await expect(parked).rejects.toMatchObject({ code: "ERR_RUNTIME" });
  });

  it("write after caller close() rejects ERR_INPUT_CLOSED (non-terminal)", async () => {
    const inv = new InvocationImpl<string, string>();
    await inv.close();
    await expect(inv.write("late")).rejects.toMatchObject({ code: ERR_INPUT_CLOSED });
    // Non-terminal: the invocation continues; outputs still flow.
    await inv.emitOutput("still alive");
    inv.closeOutput();
    expect(await collect(inv.outputs)).toEqual(["still alive"]);
  });

  it("binding closeInput() frees the caller from closing; later writes reject [NI, U]", async () => {
    const inv = new InvocationImpl<string, string>();
    await inv.closeInput(); // binding-side: no-input operation
    await expect(inv.write("x")).rejects.toMatchObject({ code: ERR_INPUT_CLOSED });
    await inv.emitOutput("out");
    inv.closeOutput();
    expect(await collect(inv.outputs)).toEqual(["out"]);
    await expect(inv.closed).resolves.toBeUndefined();
  });

  it("write after terminal rejects with the terminal error", async () => {
    const inv = new InvocationImpl<string, never>();
    const term = new InvocationError("ERR_RUNTIME");
    inv.fireError(term);
    await expect(inv.write("x")).rejects.toBe(term);
  });
});

describe("OBI-T-07 validation hook", () => {
  it("an invalid write rejects AND the invocation terminates with the same error (dual signal)", async () => {
    const t07 = new InvocationError(ERR_VALIDATION_FAILED);
    const inv = new InvocationImpl<number, never>({
      validateInput: (v) => (v < 0 ? t07 : null),
    });
    await inv.write(1); // valid
    await expect(inv.write(-1)).rejects.toBe(t07);
    await expect(inv.closed).rejects.toBe(t07);
    // The binding's read loop throws the same terminal.
    const it = inv.inputs()[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toBe(t07);
  });
});

describe("cancellation & close", () => {
  it("the signal aborts on EVERY terminal transition (Done() parity with Go)", () => {
    // fireError — including caller-side terminals like T-07 — must tear
    // down binding work; the signal is the binding's only lifecycle channel.
    const errored = new InvocationImpl<never, never>();
    expect(errored.signal.aborted).toBe(false);
    errored.fireError(new InvocationError("ERR_RUNTIME"));
    expect(errored.signal.aborted).toBe(true);

    const closed = new InvocationImpl<never, never>();
    closed.closeOutput();
    expect(closed.signal.aborted).toBe(true);
  });

  it("cancel() before any drive tears down an inert handle", async () => {
    const inv = new InvocationImpl<never, never>();
    await inv.cancel();
    expect(inv.signal.aborted).toBe(true);
    await expect(inv.closed).rejects.toMatchObject({ code: ERR_CANCELLED });
  });

  it("an external signal converges with handle-cancel on one ERR_CANCELLED [SS, BD]", async () => {
    const ctrl = new AbortController();
    const inv = new InvocationImpl<never, number>({ signal: ctrl.signal });
    ctrl.abort();
    await tick();
    expect(inv.signal.aborted).toBe(true);
    await expect(inv.closed).rejects.toMatchObject({ code: ERR_CANCELLED });
  });

  it("a pre-aborted external signal yields an immediately-terminal handle", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const inv = new InvocationImpl<never, never>({ signal: ctrl.signal });
    await expect(inv.closed).rejects.toMatchObject({ code: ERR_CANCELLED });
  });

  it("removes its external-signal listener on every terminal — no per-invocation leak on a shared signal", () => {
    // A long-lived shared signal (the documented server-shutdown / session
    // controller reused across calls) must not accumulate one retained abort
    // listener — each pinning a whole InvocationImpl and its buffers — per
    // completed invocation. The internal controller aborts on every terminal
    // and the external listener is registered against it, so terminal tears
    // the listener down even when the external signal never fires.
    const shared = new AbortController();
    const N = 50;
    for (let i = 0; i < N; i++) {
      const inv = new InvocationImpl<never, number>({ signal: shared.signal });
      inv.closeOutput(); // normal completion: `shared` never aborts
    }
    expect(getEventListeners(shared.signal, "abort").length).toBe(0);

    // The listener also unregisters on the error terminal.
    const errored = new InvocationImpl<never, number>({ signal: shared.signal });
    errored.fireError(new InvocationError("ERR_RUNTIME"));
    expect(getEventListeners(shared.signal, "abort").length).toBe(0);

    // And a live external abort still reaches a not-yet-terminal invocation.
    const live = new InvocationImpl<never, number>({ signal: shared.signal });
    expect(getEventListeners(shared.signal, "abort").length).toBe(1);
    shared.abort();
    expect(live.signal.aborted).toBe(true);
    expect(getEventListeners(shared.signal, "abort").length).toBe(0);
  });

  // --- Caller-owned deadlines and cancellation share one abstract code ---

  it("a mid-stream lifetime deadline is ERR_CANCELLED; emitted outputs stand [SS]", async () => {
    const inv = new InvocationImpl<never, number>({ signal: AbortSignal.timeout(15) });
    await inv.emitOutput(1);
    await inv.emitOutput(2);

    const seen: number[] = [];
    let caught: unknown;
    try {
      for await (const v of inv.outputs) seen.push(v);
    } catch (err) {
      caught = err;
    }
    expect(seen).toEqual([1, 2]); // previously-emitted outputs stand
    const ie = caught as InvocationError;
    expect(ie).toBeInstanceOf(InvocationError);
    expect(ie.code).toBe(ERR_CANCELLED);
  });

  it("a pre-fired timeout signal yields an immediately-terminal ERR_CANCELLED handle", async () => {
    const signal = AbortSignal.timeout(0);
    await new Promise((r) => setTimeout(r, 5)); // let the deadline fire
    expect(signal.aborted).toBe(true);
    const inv = new InvocationImpl<never, never>({ signal });
    await expect(inv.closed).rejects.toMatchObject({
      code: ERR_CANCELLED,
    });
  });

  it("an explicit cancel() mid-stream stays ERR_CANCELLED; emitted output stands [SS]", async () => {
    const inv = new InvocationImpl<never, number>();
    await inv.emitOutput(1);
    void inv.cancel();

    const seen: number[] = [];
    let caught: unknown;
    try {
      for await (const v of inv.outputs) seen.push(v);
    } catch (err) {
      caught = err;
    }
    expect(seen).toEqual([1]);
    const ie = caught as InvocationError;
    expect(ie.code).toBe(ERR_CANCELLED);
  });

  it("breaking out of `for await` cancels the invocation (return() wiring)", async () => {
    const inv = new InvocationImpl<never, number>();
    await inv.emitOutput(1);
    await inv.emitOutput(2);
    for await (const v of inv.outputs) {
      expect(v).toBe(1);
      break;
    }
    expect(inv.signal.aborted).toBe(true);
    await expect(inv.closed).rejects.toMatchObject({ code: ERR_CANCELLED });
  });
});

describe("bidi & drive", () => {
  it("separate-context drive succeeds with buffers smaller than the message count [BD]", async () => {
    const inv = new InvocationImpl<number, number>();
    const N = 25; // far beyond both buffer bounds

    // The "binding": echo loop on its own context.
    const binding = (async () => {
      for await (const v of inv.inputs()) {
        await inv.emitOutput(v * 2);
      }
      inv.closeOutput();
    })();

    // The caller: pump and drain on separate contexts (the blessed pattern).
    const pump = (async () => {
      for (let i = 0; i < N; i++) await inv.write(i);
      await inv.close();
    })();
    const seen: number[] = [];
    const drain = (async () => {
      for await (const v of inv.outputs) seen.push(v);
    })();

    await Promise.all([pump, drain, binding]);
    expect(seen).toEqual(Array.from({ length: N }, (_, i) => i * 2));
  });

  it("CONTEXT_REQUIRED is just a terminal code on the handle", async () => {
    const inv = new InvocationImpl<never, never>();
    inv.fireError(
      new InvocationError(CONTEXT_REQUIRED, {
        target: "https://api.example.com",
        alternatives: [{ requirements: [{ type: "auth.bearer" }] }],
      }),
    );
    await expect(inv.closed).rejects.toMatchObject({ code: CONTEXT_REQUIRED });
  });
});

describe("InvocationError portable record", () => {
  it("keeps presentation local while preserving CONTEXT_REQUIRED data", () => {
    const err = new InvocationError(CONTEXT_REQUIRED, {
      target: "https://api.example.com",
      alternatives: [
        { requirements: [{ type: "auth.bearer" }] },
        { requirements: [{ type: "auth.apiKey" }] },
      ],
    });
    expect(err.message).toBe(CONTEXT_REQUIRED);
    expect(err.data).toMatchObject({ target: "https://api.example.com" });
    expect(JSON.parse(JSON.stringify(err))).toEqual({
      code: CONTEXT_REQUIRED,
      data: err.data,
    });
  });

  it("distinguishes absent data from an explicit JSON null", () => {
    const absent = new InvocationError(ERR_VALIDATION_FAILED);
    const explicitNull = new InvocationError(ERR_VALIDATION_FAILED, null);
    expect(Object.hasOwn(absent, "data")).toBe(false);
    expect(Object.hasOwn(explicitNull, "data")).toBe(true);
    expect(JSON.parse(JSON.stringify(absent))).toEqual({
      code: ERR_VALIDATION_FAILED,
    });
    expect(JSON.parse(JSON.stringify(explicitNull))).toEqual({
      code: ERR_VALIDATION_FAILED,
      data: null,
    });
  });

  it("does not promote valid data into the inherited local message", () => {
    const err = new InvocationError(CONTEXT_REQUIRED, {
      target: "",
      alternatives: [{ requirements: [{ type: "auth.bearer" }] }],
    });
    expect(err.message).toBe(CONTEXT_REQUIRED);
  });

  it("rejects malformed CONTEXT_REQUIRED data and empty codes", () => {
    expect(() => new InvocationError(CONTEXT_REQUIRED, { target: "", alternatives: [] })).toThrow(TypeError);
    expect(() => new InvocationError(CONTEXT_REQUIRED, {
      target: "",
      alternatives: [{ requirements: [{ type: "auth.bearer", name: "" }] }],
    })).toThrow(TypeError);
    expect(() => new InvocationError("")).toThrow(TypeError);
  });

  it("rejects non-JSON data without coercing native values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const sparse: unknown[] = Array(2);
    sparse[1] = "sparse";
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      undefined,
      new Uint8Array([1, 2]),
      new Date(),
      { missing: undefined },
      sparse,
      cyclic,
    ]) {
      if (value === undefined) continue; // undefined selects the absent-data constructor form.
      expect(() => new InvocationError(ERR_VALIDATION_FAILED, value)).toThrow(TypeError);
    }
  });

  it("rejects hidden data and exposes a frozen wire-equivalent value", () => {
    const hidden = { public: true };
    Object.defineProperty(hidden, "nativeStatus", { value: 599 });
    expect(() => new InvocationError("APPLICATION_FAILURE", hidden)).toThrow(TypeError);

    const authored = { nested: { accepted: false }, numeric: -0 };
    const error = new InvocationError("APPLICATION_FAILURE", authored);
    authored.nested.accepted = true;
    expect(error.data).toEqual({ nested: { accepted: false }, numeric: 0 });
    expect(Object.isFrozen(error.data)).toBe(true);
    expect(Object.isFrozen((error.data as { nested: object }).nested)).toBe(true);
    expect(JSON.parse(JSON.stringify(error)).data).toEqual(error.data);
  });
});

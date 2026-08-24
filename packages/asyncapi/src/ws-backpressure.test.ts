import { WebSocketServer } from "ws";
import { describe, it, expect } from "vitest";
import type { Invocation } from "@openbindings/invoke";
import { AsyncAPIInvoker } from "./invoker.js";
import { BINDING_SPEC } from "./constants.js";
import { setBackpressureBoundsForTest } from "@openbindings/asyncapi-client/testing";

// WS slow-consumer backpressure (spec/binding-specs/asyncapi/openbindings.asyncapi.md, "WS slow-consumer
// backpressure" open point, settled 2026-07-11): the receive path bounds
// undelivered frames between the socket and the output pump at
// MAX_BUFFERED_FRAMES frames or MAX_BUFFERED_BYTES in-flight bytes,
// whichever trips first; overflow fails that subscription loudly rather
// than buffering unboundedly. Mirrors the Go SDK's
// TestWSReceiveBackpressure_* suite in formats/asyncapi/ws_backpressure_test.go.

function startServer(): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const addr = wss.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ wss, port });
    });
  });
}

function spec(port: number) {
  return {
    asyncapi: "3.0.0",
    info: { title: "WS backpressure test", version: "1.0.0" },
    servers: { test: { host: `127.0.0.1:${port}`, protocol: "ws" as const } },
    channels: {
      stream: {
        address: "/",
        messages: { Msg: { contentType: "application/json", payload: { type: "object" } } },
      },
    },
    operations: {
      subscribe: {
        action: "send" as const,
        channel: { $ref: "#/channels/stream" },
        messages: [{ $ref: "#/channels/stream/messages/Msg" }],
      },
    },
  };
}

/** Drains an invocation's outputs to an array, capturing the terminal error
 * instead of letting it reject out of the for-await loop — the TS mirror of
 * the Go suite's drainOutputs test helper. */
async function drainOutputs(call: Invocation): Promise<{ vals: unknown[]; err: unknown }> {
  const vals: unknown[] = [];
  try {
    for await (const v of call.outputs) vals.push(v);
    return { vals, err: undefined };
  } catch (err) {
    return { vals, err };
  }
}

// Real-socket flood tests: generous timeout — CI runners flood/drain far
// slower than local hardware, and vitest's 5s default flakes there.
describe("WS receive backpressure", { timeout: 30_000 }, () => {
  it("fails the subscription loudly when the frame-count bound trips", async () => {
    // Lowered bound (the test seam, mirroring the Go suite): with a bound
    // far below the frames one TCP segment carries, a single synchronous
    // ws-dispatch burst (frames parsed from one chunk fire back-to-back
    // with no microtask turn between them) is guaranteed to trip the bound
    // before the drain loop can interleave — deterministic on any runner.
    // At the 1024 default, a slow runner could interleave delivery with the
    // drain, keep pace, never trip, and hang on a socket nobody closes.
    const bound = 64;
    const restoreBounds = setBackpressureBoundsForTest(bound, 1_000_000);
    try {
      const { wss, port } = await startServer();
      const floodCount = 512;
      let resolveFloodDone!: () => void;
      const floodDone = new Promise<void>((resolve) => {
        resolveFloodDone = resolve;
      });

      wss.on("connection", (ws) => {
        setTimeout(() => {
          for (let i = 0; i < floodCount; i++) {
            ws.send(JSON.stringify({ n: i }));
          }
          // Hang-guard: close after the flood so a hypothetical no-overflow
          // run ends in a visible assertion failure, never a parked drain.
          ws.close();
          resolveFloodDone();
        }, 20);
      });

      const invoker = new AsyncAPIInvoker();
      try {
        const call = invoker.invokeBinding({
          source: { bindingSpec: BINDING_SPEC, content: spec(port) },
          selector: "#/operations/subscribe",
        });
        // Let the flood land in the buffer before this test ever iterates
        // outputs: the handle's own output buffer is only
        // OUTPUT_BUFFER_CAPACITY (4) deep, so it's the subscription-local
        // `frames` buffer under test that has to absorb the rest.
        await floodDone;

        const { vals, err } = await drainOutputs(call);
        expect(err).toBeInstanceOf(Error);
        expect((err as { code?: string }).code).toBe("ERR_STREAM_ERROR");
        expect(Object.hasOwn(err as object, "data")).toBe(false);
        // Drain-before-terminal: some already-buffered frames were delivered
        // ahead of the terminal error, but never everything the flood sent —
        // some frames were genuinely dropped by the overflow.
        expect(vals.length).toBeGreaterThan(0);
        expect(vals.length).toBeLessThan(floodCount);
      } finally {
        invoker.close();
        wss.close();
      }
    } finally {
      restoreBounds();
    }
  });

  it("fails the subscription loudly when the byte-budget bound trips", async () => {
    const restoreBounds = setBackpressureBoundsForTest(1_000_000, 1024);
    try {
      const { wss, port } = await startServer();
      // Below one full TCP segment's worth of frames (~1448B): a single
      // synchronous dispatch burst trips the budget deterministically.
      // ~54 bytes of JSON per frame; 200 frames is comfortably more than
      // the 1024-byte budget in total while each individual frame is far under it
      // (an accumulation trip, not a single-oversized-frame trip).
      const frameCount = 200;
      const payload = "x".repeat(32);
      let resolveFloodDone!: () => void;
      const floodDone = new Promise<void>((resolve) => {
        resolveFloodDone = resolve;
      });

      wss.on("connection", (ws) => {
        setTimeout(() => {
          for (let i = 0; i < frameCount; i++) {
            ws.send(JSON.stringify({ n: i, pad: payload }));
          }
          // Hang-guard: a hypothetical no-overflow run ends in a visible
          // assertion failure, never a parked drain.
          ws.close();
          resolveFloodDone();
        }, 20);
      });

      const invoker = new AsyncAPIInvoker();
      try {
        const call = invoker.invokeBinding({
          source: { bindingSpec: BINDING_SPEC, content: spec(port) },
          selector: "#/operations/subscribe",
        });
        await floodDone;

        const { vals, err } = await drainOutputs(call);
        expect(err).toBeInstanceOf(Error);
        expect((err as { code?: string }).code).toBe("ERR_STREAM_ERROR");
        expect(Object.hasOwn(err as object, "data")).toBe(false);
        expect(vals.length).toBeGreaterThan(0);
      } finally {
        invoker.close();
        wss.close();
      }
    } finally {
      restoreBounds();
    }
  });

  it("isolates overflow to the slow subscription; a draining sibling on the same pooled socket keeps receiving", async () => {
    const restoreBounds = setBackpressureBoundsForTest(64, 1_000_000);
    try {
      const { wss, port } = await startServer();
      const total = 512;
      let connections = 0;
      wss.on("connection", (ws) => {
        connections++;
        setTimeout(async () => {
          // Both subscriptions are started below before this delayed flood;
          // server-streaming subscriptions have no client readiness frame.
          for (let i = 0; i < total; i++) {
            ws.send(JSON.stringify({ n: i }));
            if (i % 8 === 7) {
              await new Promise((resolve) => setImmediate(resolve));
            }
          }
          ws.close();
        }, 50);
      });

      const invoker = new AsyncAPIInvoker();
      try {
        const source = { bindingSpec: BINDING_SPEC, content: spec(port) };
        // Sequence the acquires so the second one provably reuses the first
        // socket (same server|address|credential pool key).
        const slow = invoker.invokeBinding({ source, selector: "#/operations/subscribe" });
        const fast = invoker.invokeBinding({ source, selector: "#/operations/subscribe" });
        const fastDrain = drainOutputs(fast);

        const fastResult = await fastDrain;
        // The socket was genuinely shared...
        expect(connections).toBe(1);
        // ...the draining sibling received the whole stream with a clean
        // close (the slow subscription's overflow never tore the shared
        // socket down under it)...
        expect(fastResult.err).toBeUndefined();
        expect(fastResult.vals).toHaveLength(total);
        // ...and the slow subscription failed alone, with the overflow
        // terminal after draining what it had buffered.
        const slowResult = await drainOutputs(slow);
        expect((slowResult.err as { code?: string })?.code).toBe("ERR_STREAM_ERROR");
        expect(Object.hasOwn(slowResult.err as object, "data")).toBe(false);
        expect(slowResult.vals.length).toBeGreaterThan(0);
        expect(slowResult.vals.length).toBeLessThan(total);
      } finally {
        invoker.close();
        wss.close();
      }
    } finally {
      restoreBounds();
    }
  });

  it("never trips either bound for a consumer that keeps draining", async () => {
    const { wss, port } = await startServer();
    // Comfortably more than MAX_BUFFERED_FRAMES over the connection's
    // lifetime: the bound is about undelivered/in-flight frames, not a
    // cumulative lifetime cap (mirrors sse-cap.test.ts's per-event, not
    // cumulative, size cap). Sent in small paced chunks: Node's single
    // event loop means an unthrottled synchronous flood can dispatch every
    // "message" event before the consumer — sharing that same one thread —
    // ever gets a turn to drain, which is a JS-runtime scheduling artifact,
    // not the "normal draining" scenario under test (the Go SDK's
    // goroutine-per-connection reader genuinely runs concurrently with its
    // consumer, so it has no equivalent need to pace its flood). Yielding
    // between chunks gives the consumer real interleaved opportunities to
    // drain.
    const total = 1024 + 512;
    const chunkSize = 32;

    wss.on("connection", async (ws) => {
      for (let i = 0; i < total; i++) {
        ws.send(JSON.stringify({ n: i }));
        if (i % chunkSize === chunkSize - 1) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
      ws.close();
    });

    const invoker = new AsyncAPIInvoker();
    try {
      const call = invoker.invokeBinding({
        source: { bindingSpec: BINDING_SPEC, content: spec(port) },
        selector: "#/operations/subscribe",
      });
      const vals: unknown[] = [];
      for await (const v of call.outputs) vals.push(v);
      expect(vals).toHaveLength(total);
    } finally {
      invoker.close();
      wss.close();
    }
  });
});

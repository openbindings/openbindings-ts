import { WebSocketServer } from "ws";
import { describe, it, expect } from "vitest";
import type { Invocation } from "@openbindings/invoke";
import { AsyncAPIInvoker } from "./invoker.js";
import { BINDING_SPEC } from "./constants.js";

// WS delivery-unit bound (sdk-review ruling 4(a), 2026-07-20): each WS frame
// is one delivery unit, so args.maxDeliveryUnitBytes applies. The browser/
// undici WebSocket API has no pre-delivery read-limit seam (unlike Go's
// SetReadLimit), so the TS lane enforces POST-RECEIVE — each message's byte
// size is checked against the resolved bound before decode — same bound,
// same ERR_STREAM_ERROR terminal. The default-bound test doubles as the
// regression guard against Go's historical accidental ~32KiB nhooyr default:
// a >32KiB frame must pass at the 10MB default.

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
    info: { title: "WS delivery-unit bound test", version: "1.0.0" },
    servers: { test: { host: `127.0.0.1:${port}`, protocol: "ws" as const } },
    channels: {
      stream: {
        address: "/",
        messages: { Msg: { contentType: "text/plain", payload: { type: "string" } } },
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

/** Drains an invocation's outputs, capturing the terminal error instead of
 * letting it reject out of the for-await loop. */
async function drainOutputs(call: Invocation): Promise<{ vals: unknown[]; err: unknown }> {
  const vals: unknown[] = [];
  try {
    for await (const v of call.outputs) vals.push(v);
    return { vals, err: undefined };
  } catch (err) {
    return { vals, err };
  }
}

describe("WS delivery-unit bound", { timeout: 15_000 }, () => {
  it("refuses an over-bound message post-receive with the lane's ERR_STREAM_ERROR", async () => {
    const { wss, port } = await startServer();
    const bound = 1024;
    const payload = "y".repeat(4096); // > bound, single frame

    wss.on("connection", (ws) => {
      setTimeout(() => {
        ws.send(payload);
      }, 20);
    });

    const invoker = new AsyncAPIInvoker();
    try {
      const call = invoker.invokeBinding({
        source: { bindingSpec: BINDING_SPEC, content: spec(port) },
        ref: "#/operations/subscribe",
        maxDeliveryUnitBytes: bound,
      });
      const { vals, err } = await drainOutputs(call);
      expect(vals).toEqual([]);
      expect(err).toBeInstanceOf(Error);
      expect((err as { code?: string }).code).toBe("ERR_STREAM_ERROR");
      expect(Object.hasOwn(err as object, "data")).toBe(false);
    } finally {
      invoker.close();
      wss.close();
    }
  });

  it("passes a >32KiB message at the default bound (no accidental platform limit)", async () => {
    const { wss, port } = await startServer();
    const payload = "z".repeat(64 * 1024 + 1); // > 32KiB, far under the 10MB default

    wss.on("connection", (ws) => {
      setTimeout(() => {
        ws.send(payload);
        // Clean close after the one frame so the drain terminates.
        ws.close();
      }, 20);
    });

    const invoker = new AsyncAPIInvoker();
    try {
      const call = invoker.invokeBinding({
        source: { bindingSpec: BINDING_SPEC, content: spec(port) },
        ref: "#/operations/subscribe",
      });
      const { vals, err } = await drainOutputs(call);
      expect(err).toBeUndefined();
      expect(vals).toHaveLength(1);
      expect(vals[0]).toBe(payload);
    } finally {
      invoker.close();
      wss.close();
    }
  });
});

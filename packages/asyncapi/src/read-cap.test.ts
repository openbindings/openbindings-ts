import { describe, it, expect } from "vitest";
import { AsyncAPIInvoker } from "./invoker.js";
import { BINDING_SPEC } from "./constants.js";

// C6f: readResponseText must cancel the body stream before throwing on a cap
// breach — releasing the lock alone leaves the response socket pinned. This
// mirrors openapi's readResponseBytes and this package's own sse.ts, the
// pattern the non-streaming reader was the lone outlier from.

function source() {
  return {
    bindingSpec: BINDING_SPEC,
    content: JSON.stringify({
      asyncapi: "3.0.0",
      info: { title: "T", version: "1.0.0" },
      servers: { s: { host: "127.0.0.1:1", protocol: "http" } },
      channels: {
        messages: {
          address: "/messages",
          messages: { Msg: { contentType: "application/json", payload: { type: "object" } } },
        },
      },
      operations: {
        sendOpenMessage: {
          action: "receive" as const,
          channel: { $ref: "#/channels/messages" },
          messages: [{ $ref: "#/channels/messages/messages/Msg" }],
          bindings: { http: { method: "POST", bindingVersion: "0.3.0" } },
          reply: {
            messages: [{ name: "Reply", contentType: "application/json" }],
          },
        },
      },
    }),
  };
}

describe("AsyncAPI readResponseText cap (C6f)", () => {
  it("refuses an invalid UTF-8 reply instead of replacement-decoding it", async () => {
    const customFetch = async () =>
      new Response(new Uint8Array([0xc3, 0x28]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const invoker = new AsyncAPIInvoker();
    const call = invoker.invokeBinding({
      source: source(),
      ref: "#/operations/sendOpenMessage",
      fetch: customFetch,
    });
    await call.write({ text: "hi" });
    await expect(call.closed).rejects.toMatchObject({ code: "ERR_RESPONSE_ERROR" });
  });

  it("cancels the response reader on an over-cap body, not just releaseLock", async () => {
    let cancelled = false;
    const oversized = new Uint8Array(10 * 1024 * 1024 + 16); // > MAX_RESPONSE_BYTES
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized);
        // Deliberately not closed: the cap check fires on the first read.
      },
      cancel() {
        cancelled = true;
      },
    });
    const customFetch = async () =>
      new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });

    const invoker = new AsyncAPIInvoker();
    const call = invoker.invokeBinding({
      source: source(),
      ref: "#/operations/sendOpenMessage",
      fetch: customFetch,
    });
    await call.write({ text: "hi" });
    await expect(call.closed).rejects.toMatchObject({ code: "ERR_RESPONSE_ERROR" });
    expect(cancelled).toBe(true);
  });

  it("honors a caller-tuned delivery-unit bound on the unary reply (identity unchanged)", async () => {
    // The ruled knob (sdk-review ruling 4(a), 2026-07-20): a tiny
    // args.maxDeliveryUnitBytes trips the SAME ERR_RESPONSE_ERROR with the
    // SAME message template as the default cap — only the value is dynamic.
    const customFetch = async () =>
      new Response(JSON.stringify({ pad: "x".repeat(4096) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const invoker = new AsyncAPIInvoker();
    const call = invoker.invokeBinding({
      source: source(),
      ref: "#/operations/sendOpenMessage",
      fetch: customFetch,
      maxDeliveryUnitBytes: 1024,
    });
    await call.write({ text: "hi" });
    await expect(call.closed).rejects.toMatchObject({
      code: "ERR_RESPONSE_ERROR",
    });
  });
});

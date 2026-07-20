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
        },
      },
    }),
  };
}

describe("AsyncAPI readResponseText cap (C6f)", () => {
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
      fetch: customFetch as unknown as typeof fetch,
    });
    await call.write({ text: "hi" });
    await expect(call.closed).rejects.toMatchObject({ code: "ERR_RESPONSE_ERROR" });
    expect(cancelled).toBe(true);
  });
});

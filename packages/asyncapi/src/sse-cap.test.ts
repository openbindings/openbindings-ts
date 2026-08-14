import { describe, expect, it } from "vitest";
import { AsyncAPIInvoker } from "./invoker.js";
import { BINDING_SPEC } from "./constants.js";

// Revision 1 deliberately has no HTTP subscription cell. Keeping a cap test
// for the old SSE convention would advertise an implementation-defined
// transport that the binding specification now excludes. The durable
// regression is that this cell is refused before any network dispatch.
describe("standalone HTTP send operations", () => {
  it("refuses the excluded subscription cell before dispatch", async () => {
    let dispatches = 0;
    const source = {
      bindingSpec: BINDING_SPEC,
      content: {
        asyncapi: "3.0.0",
        info: { title: "Excluded SSE", version: "1.0.0" },
        servers: { test: { host: "example.test", protocol: "http" } },
        channels: {
          caps: {
            address: "/caps",
            messages: { Event: { contentType: "text/event-stream" } },
          },
        },
        operations: {
          receiveCaps: {
            action: "send" as const,
            channel: { $ref: "#/channels/caps" },
            messages: [{ $ref: "#/channels/caps/messages/Event" }],
          },
        },
      },
    };
    const call = new AsyncAPIInvoker().invokeBinding({
      source,
      ref: "#/operations/receiveCaps",
      fetch: async () => {
        dispatches++;
        return new Response(null, { status: 204 });
      },
    });

    await expect(call.closed).rejects.toMatchObject({ code: "ERR_REFUSED" });
    expect(dispatches).toBe(0);
  });
});

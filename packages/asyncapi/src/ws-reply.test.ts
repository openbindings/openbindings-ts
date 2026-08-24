import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { AsyncAPIInvoker } from "./invoker.js";
import { BINDING_SPEC } from "./constants.js";

describe("OpenBindings AsyncAPI WebSocket reply bridge", () => {
  it("preserves application values and full-duplex completion without protocol-shaped outputs", async () => {
    const server = await new Promise<{ wss: WebSocketServer; port: number }>((resolve) => {
      const wss = new WebSocketServer({ port: 0 }, () => {
        const address = wss.address();
        resolve({ wss, port: typeof address === "object" && address ? address.port : 0 });
      });
    });
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const value = JSON.parse(data.toString()) as { id: number };
        socket.send(JSON.stringify({ accepted: value.id }));
        socket.close(1000);
      });
    });
    const document = {
      asyncapi: "3.1.0",
      info: { title: "Reply bridge", version: "1" },
      defaultContentType: "application/json",
      servers: { test: { host: `127.0.0.1:${server.port}`, protocol: "ws" } },
      channels: {
        commands: {
          address: "/commands",
          messages: {
            Command: { payload: { type: "object" } },
            Result: { payload: { type: "object" } },
          },
        },
      },
      operations: {
        submit: {
          action: "receive",
          channel: { $ref: "#/channels/commands" },
          messages: [{ $ref: "#/channels/commands/messages/Command" }],
          reply: {
            channel: { $ref: "#/channels/commands" },
            messages: [{ $ref: "#/channels/commands/messages/Result" }],
          },
        },
      },
    };
    const invoker = new AsyncAPIInvoker();
    try {
      const call = invoker.invokeBinding({
        source: { bindingSpec: BINDING_SPEC, content: document },
        selector: "#/operations/submit",
        context: { configuration: { websocketMessageType: "text" } },
      });
      await call.write({ id: 91 });
      await call.close();
      const outputs: unknown[] = [];
      for await (const value of call.outputs) outputs.push(value);
      await call.closed;
      expect(outputs).toEqual([{ accepted: 91 }]);
    } finally {
      invoker.close();
      server.wss.close();
    }
  });
});

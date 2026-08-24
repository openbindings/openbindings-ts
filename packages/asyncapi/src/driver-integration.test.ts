import { describe, expect, it } from "vitest";
import {
  AsyncAPIEngine,
  type AsyncAPIProtocolDriver,
} from "@openbindings/asyncapi-client";
import { AsyncAPIInvoker } from "./invoker.js";
import { BINDING_SPEC } from "./constants.js";

describe("OpenBindings to standalone AsyncAPI driver bridge", () => {
  it("delegates an arbitrary protocol without exposing it in operation values", async () => {
    const seen: unknown[] = [];
    const driver: AsyncAPIProtocolDriver = {
      protocols: ["mqtt"],
      async execute(request, session) {
        expect(request.protocol).toBe("mqtt");
        expect(request.ref).toBe("#/operations/publish");
        for await (const value of session.inputs) seen.push(value);
        await session.emit({ accepted: true });
        session.complete();
      },
    };
    const invoker = new AsyncAPIInvoker(new AsyncAPIEngine({ drivers: [driver] }));
    const call = invoker.invokeBinding({
      source: { bindingSpec: BINDING_SPEC, content: mqttArtifact() },
      selector: "#/operations/publish",
    });
    await call.write({ id: 7 });
    await call.close();
    const outputs: unknown[] = [];
    for await (const output of call.outputs) outputs.push(output);
    await call.closed;
    expect(seen).toEqual([{ id: 7 }]);
    expect(outputs).toEqual([{ accepted: true }]);
    invoker.close();
  });
});

function mqttArtifact() {
  return {
    asyncapi: "3.1.0",
    info: { title: "MQTT bridge", version: "1" },
    defaultContentType: "application/json",
    servers: { broker: { host: "broker.example", protocol: "mqtt" } },
    channels: {
      commands: {
        address: "commands",
        messages: { command: { payload: { type: "object" } } },
      },
    },
    operations: {
      publish: {
        action: "receive",
        channel: { $ref: "#/channels/commands" },
        messages: [{ $ref: "#/channels/commands/messages/command" }],
      },
    },
  };
}

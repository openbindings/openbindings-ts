import { describe, it, expect } from "vitest";
import { AsyncAPISynthesizer } from "./invoker.js";
import { BINDING_SPEC } from "./constants.js";

// Regression coverage: the Go SDK's InspectSource suggests the same
// operation key SynthesizeInterface assigns (list_refs.go: "so an
// inspection previews exactly what synthesis names"). The TS package
// previously omitted operationKey entirely.
describe("AsyncAPISynthesizer.inspectSource operationKey", () => {
  const content = JSON.stringify({
    asyncapi: "3.0.0",
    info: { title: "Test API", version: "1.0.0" },
    channels: {
      messages: { address: "/messages" },
      events: { address: "/events" },
    },
    operations: {
      sendMessage: {
        action: "send",
        summary: "Send a message",
        channel: { $ref: "#/channels/messages" },
      },
      receiveEvent: {
        action: "receive",
        description: "Receive an event",
        channel: { $ref: "#/channels/events" },
      },
    },
  });

  it("suggests a sanitized operationKey per target", async () => {
    const result = await new AsyncAPISynthesizer().inspectSource({
      bindingSpec: BINDING_SPEC,
      content,
    });

    expect(result.exhaustive).toBe(true);
    expect(result.targets).toHaveLength(2);
    const byRef = new Map(result.targets.map((t) => [t.ref, t]));
    expect(byRef.get("#/operations/receiveEvent")?.operationKey).toBe("receiveEvent");
    expect(byRef.get("#/operations/sendMessage")?.operationKey).toBe("sendMessage");
  });

  it("matches the operation keys SynthesizeInterface assigns, including de-duplication", async () => {
    const synthesizer = new AsyncAPISynthesizer();
    const specDoc = {
      asyncapi: "3.0.0",
      info: { title: "Test", version: "1.0.0" },
      channels: { ch: { address: "/ch" } },
      operations: {
        // Two operation IDs that sanitize to the same key ("send msg" and
        // "send.msg" both sanitize to "send_msg"), to prove the
        // de-duplication (UniqueKey) logic matches synthesis too.
        "send msg": { action: "send", channel: { $ref: "#/channels/ch" } },
        "send.msg": { action: "send", channel: { $ref: "#/channels/ch" } },
      },
    };
    const specContent = JSON.stringify(specDoc);

    const iface = await synthesizer.synthesizeInterface({
      sources: [{ bindingSpec: BINDING_SPEC, content: specContent }],
    });
    const synthesizedKeys = new Set(Object.keys(iface.operations));

    const result = await synthesizer.inspectSource({ bindingSpec: BINDING_SPEC, content: specContent });
    const inspectedKeys = new Set(result.targets.map((t) => t.operationKey));

    expect(inspectedKeys).toEqual(synthesizedKeys);
  });
});

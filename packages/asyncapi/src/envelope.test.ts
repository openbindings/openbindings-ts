import { describe, expect, it } from "vitest";

import { BINDING_SPEC } from "./constants.js";
import { AsyncAPISynthesizer } from "./invoker.js";

// The routed envelope's schema shape (§9.2, ruled 2026-08-14; Go twin:
// envelope_test.go): a location-less channel parameter rides the input
// envelope beside the payload — optional (config pre-fill is the amortized
// supply), while the payload stays required; the subscribe perspective
// gains a parameter-only input; declared headers pair per message.
describe("the routed operation envelope", () => {
  const artifact = JSON.stringify({
    asyncapi: "3.0.0",
    info: { title: "Envelope", version: "1" },
    servers: { broker: { host: "broker.example:9092", protocol: "kafka" } },
    channels: {
      orders: {
        address: "orders/{region}",
        parameters: { region: { enum: ["emea", "amer"] } },
        messages: {
          order: {
            payload: { type: "object" },
            headers: { type: "object", properties: { traceId: { type: "string" } } },
          },
        },
      },
    },
    operations: {
      placeOrder: {
        action: "receive",
        channel: { $ref: "#/channels/orders" },
        messages: [{ $ref: "#/channels/orders/messages/order" }],
      },
      watchOrders: {
        action: "send",
        channel: { $ref: "#/channels/orders" },
        messages: [{ $ref: "#/channels/orders/messages/order" }],
      },
    },
  });

  it("assembles the input envelope with optional parameters", async () => {
    const iface = await new AsyncAPISynthesizer().synthesizeInterface({
      sources: [{ bindingSpec: BINDING_SPEC, content: artifact }],
    });
    const input = iface.operations.placeOrder?.input as Record<string, unknown>;
    const props = input.properties as Record<string, Record<string, unknown>>;
    expect(props.payload).toBeDefined();
    expect(props.headers).toBeDefined();
    expect(props.region!.type).toBe("string");
    expect(input.required).toEqual(expect.arrayContaining(["payload", "headers"]));
    expect(input.required).not.toContain("region");
    expect(input.additionalProperties).toBe(false);
  });

  it("gives the subscribe perspective a parameter-only input and a headers-paired output", async () => {
    const iface = await new AsyncAPISynthesizer().synthesizeInterface({
      sources: [{ bindingSpec: BINDING_SPEC, content: artifact }],
    });
    const input = iface.operations.watchOrders?.input as Record<string, unknown>;
    const inProps = input.properties as Record<string, unknown>;
    expect(Object.keys(inProps)).toEqual(["region"]);
    const output = iface.operations.watchOrders?.output as Record<string, unknown>;
    const outProps = output.properties as Record<string, unknown>;
    expect(outProps.headers).toBeDefined();
    expect(outProps.region).toBeUndefined();
  });
});

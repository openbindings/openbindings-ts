import { describe, it, expect } from "vitest";
import { convertToInterface } from "./create.js";
import { parseAsyncAPIDocument } from "./util.js";

const MINIMAL_DOC = {
  asyncapi: "3.0.0",
  info: { title: "Event API", version: "2.0.0", description: "An event-driven API" },
  channels: {
    messages: {
      address: "/messages",
      messages: {
        Msg: { payload: { type: "object", properties: { text: { type: "string" } } } },
      },
    },
    events: {
      address: "/events",
      messages: {
        Event: { payload: { type: "object", properties: { kind: { type: "string" } } } },
      },
    },
  },
  operations: {
    sendMessage: {
      action: "send",
      channel: { $ref: "#/channels/messages" },
      messages: [{ $ref: "#/channels/messages/messages/Msg" }],
    },
    receiveEvents: {
      action: "receive",
      channel: { $ref: "#/channels/events" },
      messages: [{ $ref: "#/channels/events/messages/Event" }],
    },
  },
};

async function parsedDoc(spec: Record<string, unknown>) {
  return parseAsyncAPIDocument(undefined, JSON.stringify(spec));
}

describe("convertToInterface", () => {
  it("copies metadata from info", async () => {
    const doc = await parsedDoc(MINIMAL_DOC);
    const iface = await convertToInterface(undefined, doc);

    expect(iface.name).toBe("Event API");
    expect(iface.version).toBe("2.0.0");
    expect(iface.description).toBe("An event-driven API");
  });

  it("creates operations from the operations map", async () => {
    const doc = await parsedDoc(MINIMAL_DOC);
    const iface = await convertToInterface(undefined, doc);

    expect(iface.operations["sendMessage"]).toBeDefined();
    expect(iface.operations["receiveEvents"]).toBeDefined();
    expect(Object.keys(iface.operations)).toHaveLength(2);
  });

  it("creates bindings with #/operations/<id> refs", async () => {
    const doc = await parsedDoc(MINIMAL_DOC);
    const iface = await convertToInterface(undefined, doc);

    const sendBinding = iface.bindings!["sendMessage.asyncapi"];
    expect(sendBinding).toBeDefined();
    expect(sendBinding.operation).toBe("sendMessage");
    expect(sendBinding.source).toBe("asyncapi");
    expect(sendBinding.ref).toBe("#/operations/sendMessage");

    const recvBinding = iface.bindings!["receiveEvents.asyncapi"];
    expect(recvBinding).toBeDefined();
    expect(recvBinding.ref).toBe("#/operations/receiveEvents");
  });

  it("creates source entry with asyncapi@<version> format", async () => {
    const doc = await parsedDoc(MINIMAL_DOC);
    const iface = await convertToInterface(undefined, doc);

    const source = iface.sources?.["asyncapi"];
    expect(source).toBeDefined();
    expect(source!.format).toMatch(/^asyncapi@/);
  });

  it("sets source location only when provided", async () => {
    const doc = await parsedDoc(MINIMAL_DOC);

    const withLocation = await convertToInterface("https://example.com/spec.json", doc);
    expect(withLocation.sources?.["asyncapi"].location).toBe("https://example.com/spec.json");

    const withoutLocation = await convertToInterface(undefined, doc);
    expect(withoutLocation.sources?.["asyncapi"].location).toBeUndefined();
  });

  it("handles doc with no operations", async () => {
    const emptyOps = {
      asyncapi: "3.0.0",
      info: { title: "Empty", version: "0.1.0" },
      channels: {},
      operations: {},
    };
    const doc = await parsedDoc(emptyOps);
    const iface = await convertToInterface(undefined, doc);

    expect(Object.keys(iface.operations)).toHaveLength(0);
    expect(iface.name).toBe("Empty");
  });

  it("sets input schema for send operations", async () => {
    const doc = await parsedDoc(MINIMAL_DOC);
    const iface = await convertToInterface(undefined, doc);

    const sendOp = iface.operations["sendMessage"];
    expect(sendOp.input).toBeDefined();
    expect(sendOp.input!.type).toBe("object");
  });

  it("sets output schema for receive operations", async () => {
    const doc = await parsedDoc(MINIMAL_DOC);
    const iface = await convertToInterface(undefined, doc);

    const recvOp = iface.operations["receiveEvents"];
    expect(recvOp.output).toBeDefined();
    expect(recvOp.output!.type).toBe("object");
  });

  it("populates security from operation security requirements", async () => {
    const specWithSecurity = {
      asyncapi: "3.0.0",
      info: { title: "Secure API", version: "1.0.0" },
      channels: {
        messages: {
          address: "/messages",
          messages: {
            Msg: { payload: { type: "object", properties: { text: { type: "string" } } } },
          },
        },
      },
      operations: {
        sendMessage: {
          action: "send",
          channel: { $ref: "#/channels/messages" },
          messages: [{ $ref: "#/channels/messages/messages/Msg" }],
          security: [
            { $ref: "#/components/securitySchemes/bearerAuth" },
          ],
        },
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
          },
        },
      },
    };
    const doc = await parsedDoc(specWithSecurity);
    const iface = await convertToInterface(undefined, doc);

    expect(iface.security).toBeDefined();
    expect(iface.bindings!["sendMessage.asyncapi"].security).toBeDefined();
  });

  it("skips security when no security schemes", async () => {
    const doc = await parsedDoc(MINIMAL_DOC);
    const iface = await convertToInterface(undefined, doc);

    expect(iface.security).toBeUndefined();
  });
});

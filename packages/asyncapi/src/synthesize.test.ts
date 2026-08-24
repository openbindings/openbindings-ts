import { describe, it, expect } from "vitest";
import { convertToInterface } from "./synthesize.js";
import { BINDING_SPEC } from "./constants.js";
import { parseAsyncAPIDocument } from "./util.js";
import { AsyncAPISynthesizer } from "./invoker.js";

const MINIMAL_DOC = {
  asyncapi: "3.0.0",
  info: { title: "Event API", version: "2.0.0", description: "An event-driven API" },
  servers: { ws: { host: "events.example", protocol: "wss" } },
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
      action: "receive",
      channel: { $ref: "#/channels/messages" },
      messages: [{ $ref: "#/channels/messages/messages/Msg" }],
    },
    receiveEvents: {
      action: "send",
      channel: { $ref: "#/channels/events" },
      messages: [{ $ref: "#/channels/events/messages/Event" }],
    },
  },
};

async function parsedDoc(spec: Record<string, unknown>) {
  return parseAsyncAPIDocument(undefined, JSON.stringify(spec));
}

describe("convertToInterface", () => {
  it("synthesizes from operation and message traits normalized by the standalone client", async () => {
    const doc = await parsedDoc({
      asyncapi: "3.0.0",
      info: { title: "Trait API", version: "1" },
      servers: { api: { host: "api.example.test", protocol: "https" } },
      channels: {
        commands: {
          address: "/commands",
          messages: {
            Command: {
              payload: { type: "object", properties: { id: { type: "integer" } } },
              traits: [{ $ref: "#/components/messageTraits/json" }],
            },
          },
        },
      },
      operations: {
        submit: {
          action: "receive",
          channel: { $ref: "#/channels/commands" },
          messages: [{ $ref: "#/channels/commands/messages/Command" }],
          traits: [{ $ref: "#/components/operationTraits/httpPost" }],
        },
      },
      components: {
        operationTraits: {
          httpPost: { summary: "Submit a command", bindings: { http: { method: "POST" } } },
        },
        messageTraits: { json: { contentType: "application/json" } },
      },
    });
    const iface = await convertToInterface(undefined, doc);
    expect(iface.operations["submit"]).toEqual(expect.objectContaining({
      description: "Submit a command",
      input: { type: "object", properties: { id: { type: "integer" } } },
    }));
    expect(iface.bindings?.["submit.asyncapi"]).toBeDefined();
  });

  it("ignores Reference Object siblings and canonically orders schema alternatives", async () => {
    const doc = await parsedDoc({
      asyncapi: "3.0.0",
      info: { title: "Reference semantics", version: "1" },
      servers: { ws: { host: "events.example", protocol: "wss" } },
      channels: {
        events: {
          address: "/events",
          messages: {
            z: { payload: { $ref: "#/components/schemas/z", description: "ignored sibling" } },
            a: { payload: { $ref: "#/components/schemas/a" } },
          },
        },
      },
      operations: {
        subscribe: {
          action: "send",
          channel: { $ref: "#/channels/events" },
          messages: [
            { $ref: "#/channels/events/messages/z" },
            { $ref: "#/channels/events/messages/a" },
          ],
        },
      },
      components: {
        schemas: {
          z: { type: "object", properties: { a: { type: "string" }, A: { type: "number" } } },
          a: { properties: { z: { type: "string" } }, type: "object" },
        },
      },
    });
    const iface = await convertToInterface(undefined, doc);
    const output = iface.operations["subscribe"]?.output as Record<string, unknown>;
    const alternatives = output["anyOf"] as Array<Record<string, unknown>>;

    expect(alternatives).toHaveLength(2);
    expect(alternatives[0]).toEqual({
      type: "object",
      properties: { a: { type: "string" }, A: { type: "number" } },
    });
    expect(alternatives[1]).toEqual({ properties: { z: { type: "string" } }, type: "object" });
    expect(alternatives[0]).not.toHaveProperty("description");
  });

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
    if (!sendBinding) throw new Error("missing binding: sendMessage.asyncapi");
    expect(sendBinding).toBeDefined();
    expect(sendBinding.operation).toBe("sendMessage");
    expect(sendBinding.source).toBe("asyncapi");
    expect(sendBinding.selector).toBe("#/operations/sendMessage");

    const recvBinding = iface.bindings!["receiveEvents.asyncapi"];
    if (!recvBinding) throw new Error("missing binding: receiveEvents.asyncapi");
    expect(recvBinding).toBeDefined();
    expect(recvBinding.selector).toBe("#/operations/receiveEvents");
  });

  it("creates source entry stamped with the exact binding-specification identifier", async () => {
    const doc = await parsedDoc(MINIMAL_DOC);
    const iface = await convertToInterface(undefined, doc);

    const source = iface.sources?.["asyncapi"];
    expect(source).toBeDefined();
    expect(source!.bindingSpec).toBe(BINDING_SPEC);
  });

  it("sets source location only when provided", async () => {
    const doc = await parsedDoc(MINIMAL_DOC);

    const withLocation = await convertToInterface("https://example.com/spec.json", doc);
    expect(withLocation.sources?.["asyncapi"]!.location).toBe("https://example.com/spec.json");

    const withoutLocation = await convertToInterface(undefined, doc);
    expect(withoutLocation.sources?.["asyncapi"]!.location).toBeUndefined();
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

  it("sets input schema for receive operations (invoking publishes, ASYNC-P-02)", async () => {
    const doc = await parsedDoc(MINIMAL_DOC);
    const iface = await convertToInterface(undefined, doc);

    const pubOp = iface.operations["sendMessage"];
    if (!pubOp) throw new Error("missing operation: sendMessage");
    expect(pubOp.input).toBeDefined();
    expect((pubOp.input as Record<string, unknown>).type).toBe("object");
  });

  it("sets output schema for send operations (invoking subscribes, ASYNC-P-02)", async () => {
    const doc = await parsedDoc(MINIMAL_DOC);
    const iface = await convertToInterface(undefined, doc);

    const subOp = iface.operations["receiveEvents"];
    if (!subOp) throw new Error("missing operation: receiveEvents");
    expect(subOp.output).toBeDefined();
    expect((subOp.output as Record<string, unknown>).type).toBe("object");
  });

  it("omits security metadata (credentials are runtime context, not OBI surface)", async () => {
    const specWithSecurity = {
      asyncapi: "3.0.0",
      info: { title: "Secure API", version: "1.0.0" },
      servers: { ws: { host: "events.example", protocol: "wss" } },
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

    expect(Object.keys(iface)).not.toContain("security");
    const sendBinding = iface.bindings!["sendMessage.asyncapi"];
    if (!sendBinding) throw new Error("missing binding: sendMessage.asyncapi");
    expect(Object.keys(sendBinding)).not.toContain("security");
  });

  it("orders mixed-case operation ids by code point, not locale collation", async () => {
    const doc = await parsedDoc({
      asyncapi: "3.0.0",
      info: { title: "Event API", version: "1.0.0" },
      servers: { ws: { host: "events.example", protocol: "wss" } },
      channels: {
        messages: {
          address: "/messages",
          messages: {
            Msg: { payload: { type: "object" } },
          },
        },
      },
      operations: {
        alpha: {
          action: "receive",
          channel: { $ref: "#/channels/messages" },
          messages: [{ $ref: "#/channels/messages/messages/Msg" }],
        },
        Zulu: {
          action: "receive",
          channel: { $ref: "#/channels/messages" },
          messages: [{ $ref: "#/channels/messages/messages/Msg" }],
        },
      },
    });
    const iface = await convertToInterface(undefined, doc);

    // "Z" (U+005A) < "a" (U+0061) by code point — the order Go's byte-wise
    // comparison produces; ICU locale collation would flip the pair.
    expect(Object.keys(iface.operations)).toEqual(["Zulu", "alpha"]);
  });

  it("cuts cyclic schema graphs at the artifact's own component ref, one artifact-named $defs entry (F7 cut-point parity)", async () => {
    // The F7 mechanism: a self-referential component whose $ref carries a
    // sibling (protoc-generated artifacts do this with `title`), reached
    // from the payload through TWO selector sites. The shared-graph pipeline
    // used to cut at anonymous interior nodes and name entries from
    // registry pointers ("0", "constraints", "payload"); the raw lane cuts
    // at the artifact's literal selector by construction, so both occurrences
    // collapse onto one component-named entry — byte-identical to Go.
    const doc = await parsedDoc({
      asyncapi: "3.0.0",
      info: { title: "Cyclic", version: "1" },
      servers: { ws: { host: "events.example", protocol: "wss" } },
      channels: {
        nodes: {
          address: "/nodes",
          messages: {
            Node: { payload: { $ref: "#/components/schemas/Node" } },
          },
        },
      },
      operations: {
        sendNode: {
          action: "receive",
          channel: { $ref: "#/channels/nodes" },
          messages: [{ $ref: "#/channels/nodes/messages/Node" }],
        },
      },
      components: {
        schemas: {
          Node: {
            type: "object",
            properties: {
              first: { $ref: "#/components/schemas/Node", title: "first child" },
              second: { $ref: "#/components/schemas/Node", title: "second child" },
            },
          },
        },
      },
    });
    const iface = await convertToInterface(undefined, doc);

    const input = iface.operations["sendNode"]?.input as Record<string, unknown>;
    expect(Object.keys(input["$defs"] as Record<string, unknown>)).toEqual(["Node"]);
    const properties = input["properties"] as Record<string, Record<string, unknown>>;
    // Every occurrence points at the single hoisted entry; the artifact's
    // selector siblings survive beside the rewritten pointer.
    expect(properties["first"]).toMatchObject({
      $ref: "#/operations/sendNode/input/$defs/Node",
      title: "first child",
    });
    expect(properties["second"]).toMatchObject({
      $ref: "#/operations/sendNode/input/$defs/Node",
      title: "second child",
    });
    const hoisted = (input["$defs"] as Record<string, Record<string, unknown>>)["Node"]!;
    const hoistedProperties = hoisted["properties"] as Record<string, Record<string, unknown>>;
    expect(hoistedProperties["first"]!["$ref"]).toBe("#/operations/sendNode/input/$defs/Node");
    expect(hoistedProperties["second"]!["$ref"]).toBe("#/operations/sendNode/input/$defs/Node");
  });
});

describe("AsyncAPI synthesis coverage", () => {
  it("preserves native AsyncAPI 2.x refs and complementary perspective", async () => {
    const content = {
      asyncapi: "2.6.0",
      info: { title: "Legacy events", version: "1" },
      servers: { broker: { url: "mqtt://broker.example", protocol: "mqtt" } },
      channels: {
        "events/{tenant}": {
          publish: { message: { payload: { type: "object", required: ["id"] } } },
        },
      },
    };
    const result = await new AsyncAPISynthesizer().synthesizeInterfaceWithCoverage({
      sources: [{ bindingSpec: BINDING_SPEC, content }],
    });
    expect(Object.values(result.interface.bindings ?? {})[0]?.selector).toBe(
      "#/channels/events~1{tenant}/publish",
    );
    expect(Object.values(result.interface.operations)[0]?.input).toMatchObject({
      type: "object",
      required: ["id"],
    });
    expect(result.coverage.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "represented", scope: "target" }),
      expect.objectContaining({ sourceSelector: expect.stringContaining("#server[0]=broker"), status: "represented" }),
    ]));
  });

  it("synthesizes both directions of a reply-bearing send independently of driver support", async () => {
    const content = {
      asyncapi: "3.0.0",
      info: { title: "Reply-bearing send", version: "1" },
      servers: { ws: { host: "api.example", protocol: "wss" } },
      channels: {
        events: {
          address: "/events",
          messages: { event: { payload: { type: "object" } } },
        },
        commands: {
          address: "/commands",
          messages: { command: { payload: { type: "string" } } },
        },
      },
      operations: {
        subscribe: {
          action: "send",
          channel: { $ref: "#/channels/events" },
          messages: [{ $ref: "#/channels/events/messages/event" }],
          reply: { messages: [{ $ref: "#/channels/commands/messages/command" }] },
        },
      },
    };

    const current = await new AsyncAPISynthesizer().synthesizeInterfaceWithCoverage({
      sources: [{ bindingSpec: BINDING_SPEC, content }],
    });
    expect(current.interface.operations["subscribe"]).toMatchObject({
      input: { type: "string" },
      output: { type: "object" },
    });
    expect(current.coverage.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceSelector: "#/operations/subscribe",
        status: "represented",
      }),
      expect.objectContaining({
        sourceSelector: "#/operations/subscribe#reply-message[0]=#/channels/commands/messages/command",
        status: "represented",
      }),
    ]));
  });

  it("gives a reply declared by reference the same coverage identity as an inline reply", async () => {
    // A Reply Object may be a Reference Object into components.replies. The
    // reply's declared message pointer must survive that spelling, or coverage
    // cites a bare message name for the referenced form and the full pointer for
    // the inline one, disagreeing with itself and with the Go SDK.
    const content = {
      asyncapi: "3.0.0",
      info: { title: "Referenced reply", version: "1" },
      servers: { ws: { host: "api.example", protocol: "wss" } },
      channels: {
        events: {
          address: "/events",
          messages: { event: { payload: { type: "object" } } },
        },
        commands: {
          address: "/commands",
          messages: { command: { name: "command", payload: { type: "string" } } },
        },
      },
      components: {
        replies: {
          commandReply: { messages: [{ $ref: "#/channels/commands/messages/command" }] },
        },
      },
      operations: {
        subscribe: {
          action: "send",
          channel: { $ref: "#/channels/events" },
          messages: [{ $ref: "#/channels/events/messages/event" }],
          reply: { $ref: "#/components/replies/commandReply" },
        },
      },
    };

    const current = await new AsyncAPISynthesizer().synthesizeInterfaceWithCoverage({
      sources: [{ bindingSpec: BINDING_SPEC, content }],
    });
    expect(current.interface.operations["subscribe"]).toMatchObject({
      input: { type: "string" },
      output: { type: "object" },
    });
    expect(current.coverage.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceSelector: "#/operations/subscribe#reply-message[0]=#/channels/commands/messages/command",
      }),
    ]));
  });

  it("accounts for message alternatives and declared protocol cells", async () => {
    const content = {
      asyncapi: "3.0.0",
      info: { title: "Events", version: "1" },
      servers: {
        http: { host: "api.example", protocol: "https" },
        ws: { host: "api.example", protocol: "wss" },
        broker: { host: "api.example", protocol: "mqtt" },
      },
      channels: {
        events: {
          address: "/events",
          messages: {
            good: { payload: { type: "object" } },
            headers: { headers: { type: "object" }, payload: { type: "object" } },
          },
        },
        replies: {
          messages: { reply: { payload: { type: "string" } } },
        },
      },
      operations: {
        publish: {
          action: "receive",
          channel: { $ref: "#/channels/events" },
          bindings: { http: { method: "POST" } },
          reply: { channel: { $ref: "#/channels/replies" } },
        },
      },
    };
    const result = await new AsyncAPISynthesizer().synthesizeInterfaceWithCoverage({
      sources: [{ bindingSpec: BINDING_SPEC, content }],
    });
    // The routed-envelope ruling (2026-08-14): the headers-declaring
    // message alternative is represented, so every cell is represented.
    expect(result.coverage).toMatchObject({
      exhaustive: true,
      fullyRepresented: true,
    });
    expect(result.coverage.entries.some((entry) => entry.reasonCode === "asyncapi.message_headers")).toBe(false);
    expect(result.coverage.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceSelector: "#/operations/publish",
        status: "represented",
      }),
      expect.objectContaining({
        sourceSelector: "#/operations/publish#server[0]=broker",
        status: "represented",
      }),
      expect.objectContaining({
        sourceSelector: "#/operations/publish#server[2]=ws",
        status: "represented",
      }),
    ]));
  });
});

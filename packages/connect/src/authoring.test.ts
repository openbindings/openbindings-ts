import { describe, expect, it } from "vitest";
import { single } from "@openbindings/invoke";
import { BINDING_SPEC, ConnectInvoker, ConnectSynthesizer, envelope } from "./index.js";

const content = {
  file: [{
    name: "echo.proto", package: "demo", syntax: "proto3",
    messageType: [{ name: "Request", field: [{ name: "value", number: 1, label: "LABEL_OPTIONAL", type: "TYPE_STRING" }] }],
    service: [{ name: "Echo", method: [
      { name: "Call", inputType: ".demo.Request", outputType: ".demo.Request" },
      { name: "Chat", inputType: ".demo.Request", outputType: ".demo.Request", clientStreaming: true, serverStreaming: true },
      { name: "Upload", inputType: ".demo.Request", outputType: ".demo.Request", clientStreaming: true },
      { name: "Watch", inputType: ".demo.Request", outputType: ".demo.Request", serverStreaming: true },
    ] }],
  }],
};

describe("ConnectSynthesizer", () => {
  it("returns the deterministic source-less scaffold", async () => {
    await expect(new ConnectSynthesizer().synthesizeInterface({ name: "scaffold" })).resolves.toEqual({
      openbindings: "0.2.0", name: "scaffold", operations: {},
    });
  });

  it("synthesizes and inspects every binding-spec-supported method kind", async () => {
    const source = { bindingSpec: BINDING_SPEC, location: "https://connect.example.test", content };
    const synth = new ConnectSynthesizer();
    const iface = await synth.synthesizeInterface({ sources: [source] });
    const inspection = await synth.inspectSource(source);
    expect(inspection.targets.map((target) => target.selector)).toEqual([
      "demo.Echo/Call", "demo.Echo/Chat", "demo.Echo/Upload", "demo.Echo/Watch",
    ]);
    expect(Object.values(iface.bindings ?? {}).map((binding) => binding.selector)).toEqual([
      "demo.Echo/Call", "demo.Echo/Chat", "demo.Echo/Upload", "demo.Echo/Watch",
    ]);
    expect(iface.sources?.default).toEqual(source);
  });

  it("refuses to invent a method set in descriptorless mode", async () => {
    await expect(new ConnectSynthesizer().inspectSource({
      bindingSpec: BINDING_SPEC,
      location: "https://connect.example.test",
    })).rejects.toThrow(/no discoverable operation set/);
  });

  it("accounts for schema-range exclusions without advertising an uninvocable method", async () => {
    const source = {
      bindingSpec: BINDING_SPEC,
      location: "https://connect.example.test",
      content: `syntax = "proto2";
        package demo;
        message Good { optional string value = 1; }
        message Bad { required string value = 1; }
        service Echo {
          rpc Accepted(Good) returns (Good);
          rpc Excluded(Bad) returns (Good);
        }`,
    };
    const synth = new ConnectSynthesizer();
    const result = await synth.synthesizeInterfaceWithCoverage({ sources: [source] });
    expect(Object.values(result.interface.bindings ?? {}).map((binding) => binding.selector)).toEqual([
      "demo.Echo/Accepted",
    ]);
    expect(result.coverage).toMatchObject({
      exhaustive: true,
      fullyRepresented: false,
      entries: [
        { sourceSelector: "demo.Echo/Accepted", status: "represented" },
        {
          sourceSelector: "demo.Echo/Excluded",
          status: "excluded",
          reasonCode: "connect.schema_range",
          rule: "CONN-P-02",
        },
      ],
    });
    await expect(synth.inspectSource(source)).resolves.toMatchObject({
      exhaustive: true,
      targets: [{ selector: "demo.Echo/Accepted" }],
    });
  });

  it("projects recursive ProtoJSON input and output without widening either direction", async () => {
    const source = {
      bindingSpec: BINDING_SPEC,
      location: "https://connect.example.test",
      content: `syntax = "proto3";
        package demo;
        message Node {
          int64 count_value = 1;
          Node next = 2;
          map<int32, string> labels = 5;
          bytes payload = 6;
          oneof choice {
            string text_value = 3;
            int32 number_value = 4;
          }
        }
        service Echo { rpc Call(Node) returns (Node); }`,
    };
    const iface = await new ConnectSynthesizer().synthesizeInterface({ sources: [source] });
    const input = iface.operations.Call!.input as Record<string, any>;
    const output = iface.operations.Call!.output as Record<string, any>;

    expect(input.$id).toBe("urn:openbindings:generated:connect:operations.Call.input");
    expect(input.properties.next.anyOf[0].$ref).toBe(`${input.$id}#/$defs/demo.Node`);
    expect(input.properties).toHaveProperty("countValue");
    expect(input.properties).toHaveProperty("count_value");
    expect(input.properties.countValue.anyOf[0].anyOf[0]).toMatchObject({
      type: "integer",
      minimum: Number.MIN_SAFE_INTEGER,
      maximum: Number.MAX_SAFE_INTEGER,
    });
    expect(input.properties.countValue.anyOf[0].anyOf[1]).toEqual({
      type: "string",
      format: "int64",
      pattern: "^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$",
    });
    expect(input.properties.labels.anyOf[0]).toMatchObject({
      type: "object",
      propertyNames: { pattern: "^-?(?:0|[1-9][0-9]*)$" },
      additionalProperties: { type: "string" },
    });
    expect(input.properties.payload.anyOf[0].pattern).toContain("A-Za-z0-9");
    expect(input.allOf.length).toBeGreaterThan(1);

    expect(output.$id).toBe("urn:openbindings:generated:connect:operations.Call.output");
    expect(output.properties.next.$ref).toBe(`${output.$id}#/$defs/demo.Node`);
    expect(output.properties.countValue).toEqual({
      type: "string",
      format: "int64",
      pattern: "^-?(?:0|[1-9][0-9]*)$",
    });
    expect(output.properties).not.toHaveProperty("count_value");
  });

  it("round-trips a synthesized client-streaming binding through a capable transport", async () => {
    const source = { bindingSpec: BINDING_SPEC, location: "https://connect.example.test", content };
    const iface = await new ConnectSynthesizer().synthesizeInterface({ sources: [source] });
    const binding = Object.values(iface.bindings ?? {}).find((candidate) => candidate.operation === "Upload");
    expect(binding?.selector).toBe("demo.Echo/Upload");
    let requestBytes = 0;
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        requestBytes += part.value.byteLength;
      }
      const response = new Uint8Array([
        ...envelope(0, new TextEncoder().encode(JSON.stringify({ value: "done" }))),
        ...envelope(0x02, new TextEncoder().encode("{}")),
      ]);
      return new Response(response, { status: 200, headers: { "Content-Type": "application/connect+json" } });
    }) as typeof fetch;
    const call = new ConnectInvoker({ fullDuplex: true }).invokeBinding({
      source: iface.sources!.default!,
      selector: binding!.selector!,
      fetch: fetchImpl,
    });
    await call.write({ value: "a" });
    await call.write({ value: "b" });
    await call.close();
    expect(await single(call.outputs)).toEqual({ value: "done" });
    expect(requestBytes).toBeGreaterThan(10);
  });
});

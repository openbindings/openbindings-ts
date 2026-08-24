import { describe, expect, it } from "vitest";
import { BINDING_SPEC, GrpcSynthesizer } from "./index.js";

const content = {
  file: [{
    name: "echo.proto", package: "demo", syntax: "proto3",
    messageType: [{ name: "Request", field: [{ name: "value", number: 1, label: "LABEL_OPTIONAL", type: "TYPE_STRING" }] }],
    service: [{ name: "Echo", method: [
      { name: "Call", inputType: ".demo.Request", outputType: ".demo.Request" },
      { name: "Watch", inputType: ".demo.Request", outputType: ".demo.Request", serverStreaming: true },
    ] }],
  }],
};

describe("GrpcSynthesizer", () => {
  it("returns the deterministic source-less scaffold", async () => {
    await expect(new GrpcSynthesizer().synthesizeInterface({ name: "scaffold" })).resolves.toEqual({
      openbindings: "0.2.0", name: "scaffold", operations: {},
    });
  });

  it("refuses live reflection embedding instead of emitting a lossy descriptor pin", async () => {
    await expect(new GrpcSynthesizer().synthesizeInterface({
      sources: [{ bindingSpec: BINDING_SPEC, location: "grpc://localhost:50051", embed: true }],
    })).rejects.toThrow(/complete reflected descriptor closure/);
  });

  it("synthesizes and inspects the same complete method set", async () => {
    const source = { bindingSpec: BINDING_SPEC, location: "grpc://localhost:50051", content };
    const synth = new GrpcSynthesizer();
    const iface = await synth.synthesizeInterface({ sources: [source] });
    const inspection = await synth.inspectSource(source);
    expect(inspection.exhaustive).toBe(true);
    expect(inspection.targets.map((target) => target.selector)).toEqual(["demo.Echo/Call", "demo.Echo/Watch"]);
    expect(Object.values(iface.bindings ?? {}).map((binding) => binding.selector)).toEqual(inspection.targets.map((target) => target.selector));
    expect(iface.sources?.default).toEqual(source);
  });

  it("accounts for schema-range exclusions without advertising an uninvocable method", async () => {
    const source = {
      bindingSpec: BINDING_SPEC,
      location: "grpc://localhost:50051",
      content: `syntax = "proto2";
        package demo;
        message Good { optional string value = 1; }
        message Bad { required string value = 1; }
        service Echo {
          rpc Accepted(Good) returns (Good);
          rpc Excluded(Bad) returns (Good);
        }`,
    };
    const synth = new GrpcSynthesizer();
    const result = await synth.synthesizeInterfaceWithCoverage({ sources: [source] });
    expect(Object.values(result.interface.bindings ?? {}).map((binding) => binding.selector)).toEqual([
      "demo.Echo/Accepted",
    ]);
    expect(result.coverage).toMatchObject({
      exhaustive: true,
      fullyRepresented: false,
      entries: [
        { sourceRef: "demo.Echo/Accepted", status: "represented" },
        {
          sourceRef: "demo.Echo/Excluded",
          status: "excluded",
          reasonCode: "grpc.schema_range",
          rule: "GRPC-P-03",
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
      location: "grpc://localhost:50051",
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
    const iface = await new GrpcSynthesizer().synthesizeInterface({ sources: [source] });
    const input = iface.operations.Call!.input as Record<string, any>;
    const output = iface.operations.Call!.output as Record<string, any>;

    expect(input.$id).toBe("urn:openbindings:generated:grpc:operations.Call.input");
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

    expect(output.$id).toBe("urn:openbindings:generated:grpc:operations.Call.output");
    expect(output.properties.next.$ref).toBe(`${output.$id}#/$defs/demo.Node`);
    expect(output.properties.countValue).toEqual({
      type: "string",
      format: "int64",
      pattern: "^-?(?:0|[1-9][0-9]*)$",
    });
    expect(output.properties).not.toHaveProperty("count_value");
  });
});

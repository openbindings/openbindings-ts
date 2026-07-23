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
    expect(inspection.targets.map((target) => target.ref)).toEqual(["demo.Echo/Call", "demo.Echo/Watch"]);
    expect(Object.values(iface.bindings ?? {}).map((binding) => binding.ref)).toEqual(inspection.targets.map((target) => target.ref));
    expect(iface.sources?.default).toEqual(source);
  });
});

import { describe, expect, it } from "vitest";
import { ERR_SELECTOR_NOT_FOUND, ERR_VALIDATION_FAILED } from "@openbindings/invoke";
import { BINDING_SPEC, GrpcInvoker, loadProtobufSchema } from "./index.js";

const descriptorSet = {
  file: [{
    name: "echo.proto",
    package: "demo",
    syntax: "proto3",
    messageType: [
      {
        name: "Request",
        field: [{ name: "name", jsonName: "name", number: 1, label: "LABEL_OPTIONAL", type: "TYPE_STRING" }],
      },
      {
        name: "Response",
        field: [{ name: "message", jsonName: "message", number: 1, label: "LABEL_OPTIONAL", type: "TYPE_STRING" }],
      },
    ],
    service: [{
      name: "Echo",
      method: [{ name: "Call", inputType: ".demo.Request", outputType: ".demo.Response" }],
    }],
  }],
};

describe("Node gRPC runtime descriptor-set carriage", () => {
  it("resolves bundled google/protobuf imports in single-file proto content", () => {
    const root = loadProtobufSchema(`syntax = "proto3";
      package demo;
      import "google/protobuf/timestamp.proto";
      message Request { google.protobuf.Timestamp at = 1; }
      service Echo { rpc Call(Request) returns (Request); }
    `);
    expect(root.lookupType("demo.Request").fields.at?.resolvedType?.fullName).toBe(".google.protobuf.Timestamp");
  });

  it("resolves a canonical-JSON FileDescriptorSet before dispatch", async () => {
    const call = new GrpcInvoker().invokeBinding({
      source: { bindingSpec: BINDING_SPEC, location: "grpc://127.0.0.1:1", content: descriptorSet },
      selector: "demo.Echo/Call",
    });
    await call.write({ unknown: true }).catch(() => {});
    await expect(call.closed).rejects.toMatchObject({ code: ERR_VALIDATION_FAILED });
  });

  it("checks a bound selector offline and does not dial for a missing method", async () => {
    const call = new GrpcInvoker().invokeBinding({
      source: { bindingSpec: BINDING_SPEC, location: "grpc://127.0.0.1:1", content: descriptorSet },
      selector: "demo.Echo/Missing",
    });
    await expect(call.closed).rejects.toMatchObject({ code: ERR_SELECTOR_NOT_FOUND });
  });

  it("refuses unknown descriptor-set members loudly", async () => {
    const call = new GrpcInvoker().invokeBinding({
      source: {
        bindingSpec: BINDING_SPEC,
        location: "grpc://127.0.0.1:1",
        content: { ...descriptorSet, invented: true },
      },
      selector: "demo.Echo/Call",
    });
    await expect(call.closed).rejects.toMatchObject({ code: "ERR_SOURCE_LOAD_FAILED" });
  });
});

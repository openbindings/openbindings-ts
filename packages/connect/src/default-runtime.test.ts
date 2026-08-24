import { describe, expect, it } from "vitest";
import { single } from "@openbindings/invoke";
import { BINDING_SPEC, ConnectInvoker, loadProtobufSchema } from "./index.js";

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

describe("Connect default runtime schema carriages", () => {
  it("resolves bundled google/protobuf imports in single-file proto content", () => {
    const root = loadProtobufSchema(`syntax = "proto3";
      package demo;
      import "google/protobuf/duration.proto";
      message Request { google.protobuf.Duration delay = 1; }
      service Echo { rpc Call(Request) returns (Request); }
    `);
    expect(root.lookupType("demo.Request").fields.delay?.resolvedType?.fullName).toBe(".google.protobuf.Duration");
  });

  it("uses a canonical-JSON FileDescriptorSet in schema mode", async () => {
    let requestURL = "";
    const call = new ConnectInvoker().invokeBinding({
      source: { bindingSpec: BINDING_SPEC, location: "https://connect.example.test/api", content: descriptorSet },
      selector: "demo.Echo/Call",
      fetch: async (input) => {
        requestURL = String(input);
        return new Response(JSON.stringify({ message: "hello" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    await call.write({ name: "world" });
    expect(await single(call.outputs)).toEqual({ message: "hello" });
    await call.closed;
    expect(requestURL).toBe("https://connect.example.test/api/demo.Echo/Call");
  });

  it("refuses unknown descriptor-set members before dispatch", async () => {
    let dispatches = 0;
    const call = new ConnectInvoker().invokeBinding({
      source: {
        bindingSpec: BINDING_SPEC,
        location: "https://connect.example.test",
        content: { ...descriptorSet, invented: true },
      },
      selector: "demo.Echo/Call",
      fetch: async () => { dispatches++; return new Response(null, { status: 200 }); },
    });
    await expect(call.closed).rejects.toMatchObject({ code: "ERR_SOURCE_LOAD_FAILED" });
    expect(dispatches).toBe(0);
  });
});

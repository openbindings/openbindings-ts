import { describe, expect, it } from "vitest";
import { loadProtobufSchema } from "./index.js";
import { fromProtoJSON, toProtoJSON } from "./protojson.js";

const root = loadProtobufSchema(`syntax = "proto3";
  package demo;
  import "google/protobuf/duration.proto";
  import "google/protobuf/timestamp.proto";
  import "google/protobuf/wrappers.proto";
  message Request {
    google.protobuf.Duration delay = 1;
    google.protobuf.Timestamp at = 2;
    int64 count = 3;
    google.protobuf.BytesValue data = 4;
    oneof selector { string name = 5; int32 number = 6; }
  }
`);
const type = root.lookupType("demo.Request");

describe("canonical ProtoJSON", () => {
  it("round-trips nested well-known values and 64-bit strings", () => {
    const value = { delay: "1.250s", at: "2026-01-02T03:04:05.123456789Z", count: "9007199254740993" };
    const message = fromProtoJSON(type, value);
    expect(toProtoJSON(type, type.decode(type.encode(message).finish()))).toEqual(value);
  });

  it("refuses unknown fields recursively", () => {
    expect(() => fromProtoJSON(type, { delay: { seconds: "1" } })).toThrow(/Duration/);
  });

  it("accepts null as unset but refuses multiple oneof members", () => {
    expect(toProtoJSON(type, fromProtoJSON(type, { count: null, name: null }))).toEqual({});
    expect(() => fromProtoJSON(type, { name: "x", number: 1 })).toThrow(/oneof selector/);
  });

  it("enforces protobuf integer, duration, and bytes bounds", () => {
    expect(() => fromProtoJSON(type, { count: "9223372036854775808" })).toThrow(/64-bit/);
    expect(() => fromProtoJSON(type, { delay: "315576000001s" })).toThrow(/range/);
    expect(() => fromProtoJSON(type, { data: "not base64!" })).toThrow(/base64/);
    expect(toProtoJSON(type, fromProtoJSON(type, { data: "_-4" }))).toEqual({ data: "/+4=" });
  });
});

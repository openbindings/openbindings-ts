import { describe, expect, it } from "vitest";

import { BINDING_SPEC } from "./constants.js";
import { AsyncAPISynthesizer } from "./invoker.js";
import { classifySchemaFormat } from "./synthesize.js";

// Twin of Go TestClassifySchemaFormat (authoring_test.go): the pinned
// disposition set for declared schema formats.
describe("classifySchemaFormat", () => {
  const cases: Array<[string | undefined, "translate" | "passthrough" | "foreign"]> = [
    // Absent or blank: the artifact's default (Draft-07-superset) governs.
    [undefined, "translate"],
    ["", "translate"],
    ["   ", "translate"],
    // AsyncAPI default formats, any suffix, case-insensitive.
    ["application/vnd.aai.asyncapi;version=3.0.0", "translate"],
    ["application/vnd.aai.asyncapi+json;version=2.6.0", "translate"],
    ["application/vnd.aai.asyncapi+yaml", "translate"],
    ["Application/VND.AAI.AsyncAPI+JSON;Version=3.0.0", "translate"],
    // Official JSON Schema media type: version parameter decides.
    ["application/schema+json;version=draft-07", "translate"],
    ["application/schema+yaml;version=draft-07", "translate"],
    ["application/schema+json;version=draft/2020-12", "passthrough"],
    ['application/schema+json;version="draft/2020-12"', "passthrough"],
    // Unknown or absent JSON Schema version: no translation rules to apply.
    ["application/schema+json", "foreign"],
    ["application/schema+json;version=draft-04", "foreign"],
    // Foreign languages the substring heuristic previously mishandled.
    ["application/vnd.apache.avro;version=1.9.0", "foreign"],
    ["application/vnd.google.protobuf;version=2", "foreign"],
    ["application/vnd.oai.openapi;version=3.0.0", "foreign"],
    ["application/raml+yaml;version=1.0", "foreign"],
    // Malformed media types are foreign, never guessed at.
    ["not a media type", "foreign"],
    ["avro", "foreign"],
  ];

  it.each(cases)("classifySchemaFormat(%j) → %s", (format, want) => {
    expect(classifySchemaFormat(format)).toBe(want);
  });
});

// Twin of Go TestUnionPayloadSchemasPassthrough: a declared 2020-12 schema
// enters the OBI verbatim (the Draft-07 keyword walk must not touch it),
// while a declared Draft-07 schema translates.
describe("passthrough dispatch", () => {
  const artifact = (schemaFormat: string) =>
    JSON.stringify({
      asyncapi: "3.0.0",
      info: { title: "Passthrough", version: "1" },
      servers: { broker: { host: "broker.example:9092", protocol: "kafka" } },
      channels: {
        records: {
          address: "records.v1",
          messages: {
            record: {
              payload: {
                schemaFormat,
                schema: {
                  type: "object",
                  properties: { card: { type: "string" } },
                  dependencies: { card: ["cvv"] },
                },
              },
            },
          },
        },
      },
      operations: {
        publishRecord: {
          action: "receive",
          channel: { $ref: "#/channels/records" },
          messages: [{ $ref: "#/channels/records/messages/record" }],
        },
      },
    });

  it("keeps a declared 2020-12 schema verbatim", async () => {
    const iface = await new AsyncAPISynthesizer().synthesizeInterface({
      sources: [{ bindingSpec: BINDING_SPEC, content: artifact("application/schema+json;version=draft/2020-12") }],
    });
    const input = iface.operations.publishRecord?.input as Record<string, unknown>;
    expect(input.dependencies).toEqual({ card: ["cvv"] });
  });

  it("translates a declared Draft-07 schema", async () => {
    const iface = await new AsyncAPISynthesizer().synthesizeInterface({
      sources: [{ bindingSpec: BINDING_SPEC, content: artifact("application/schema+json;version=draft-07") }],
    });
    const input = iface.operations.publishRecord?.input as Record<string, unknown>;
    expect(input.dependencies).toBeUndefined();
    expect(input.dependentRequired).toEqual({ card: ["cvv"] });
  });
});

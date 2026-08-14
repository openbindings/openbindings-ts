import { describe, expect, it } from "vitest";

import { deriveAvroSchema } from "./avro.js";
import { avroMediaGuard } from "./content.js";
import { BINDING_SPEC } from "./constants.js";
import { AsyncAPISynthesizer } from "./invoker.js";

// A record that declares a named enum inline and reuses it by name (Go twin:
// avro_test.go). The derivation materializes Suit once under $defs; every
// reference — including the one inside the union branch — spells the shared
// "#/$defs/<fullname>" form for decycle to rebase.
const reusedEnumAvro = {
  type: "record",
  name: "ParentRecord",
  fields: [
    { name: "first", type: { type: "enum", name: "Suit", symbols: ["SPADES", "HEARTS"] } },
    { name: "second", type: "Suit" },
    { name: "maybe", type: ["null", "Suit"] },
  ],
};

describe("deriveAvroSchema named-type reuse", () => {
  it("materializes the named type once and refs it everywhere", () => {
    const derived = deriveAvroSchema(reusedEnumAvro);
    expect(derived).toBeDefined();
    expect(derived!["$ref"]).toBe("#/$defs/ParentRecord");
    const defs = derived!["$defs"] as Record<string, unknown>;
    expect(defs["Suit"]).toBeDefined();
    const parent = defs["ParentRecord"] as Record<string, unknown>;
    const props = parent["properties"] as Record<string, Record<string, unknown>>;
    expect(props["first"]!["$ref"]).toBe("#/$defs/Suit");
    expect(props["second"]!["$ref"]).toBe("#/$defs/Suit");
  });
});

// The emitted operation schema must contain no derivation-form ref: every
// "#/$defs/<name>" — including those inside $defs members, which ride beside
// the derived root's own $ref — rebases onto the operation pointer. The
// regression this pins: decycleNode returning at a $ref node without walking
// its siblings left the $defs interior unrebased, the pointers dangled, and
// the schema-defect gate wrongly excluded the operation (corpus specimen
// asyncapi/avro-schema-parser
// test/documents/asyncapi-with-reused-enums.yaml).
describe("avro named-type reuse end to end", () => {
  it("rebases every derivation ref onto the operation pointer", async () => {
    const artifact = JSON.stringify({
      asyncapi: "3.0.0",
      info: { title: "Reused named types", version: "1" },
      servers: { broker: { host: "broker.example:9092", protocol: "kafka" } },
      channels: {
        records: {
          address: "records.v1",
          messages: {
            record: {
              payload: {
                schemaFormat: "application/vnd.apache.avro;version=1.9.0",
                schema: reusedEnumAvro,
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
    const iface = await new AsyncAPISynthesizer().synthesizeInterface({
      sources: [{ bindingSpec: BINDING_SPEC, content: artifact }],
    });
    const op = iface.operations.publishRecord;
    expect(op, "operation wrongly excluded").toBeDefined();
    const encoded = JSON.stringify(op!.input);
    expect(encoded).not.toContain('"#/$defs/');
    expect(encoded).toContain('"#/operations/publishRecord/input/$defs/Suit"');
  });
});

// The invocation-side guard (§9.2 codec capability; Go twin:
// TestAvroMediaGuard): an Avro-declared payload refuses any non-JSON wire
// pre-dispatch — the binary encoding is an unqualified codec here — while
// JSON-family media rides the ordinary JSON lane (that lane IS the
// Avro-JSON wire).
describe("avroMediaGuard", () => {
  const avroMessage = {
    payload: {
      schemaFormat: "application/vnd.apache.avro;version=1.9.0",
      schema: { type: "record", name: "R", fields: [] },
    },
  };
  it("refuses binary media as an unqualified codec", () => {
    expect(() => avroMediaGuard(avroMessage, "avro/binary")).toThrow(/Avro binary codec/);
  });
  it("refuses the text lane for an Avro-declared payload", () => {
    expect(() => avroMediaGuard(avroMessage, "text/plain")).toThrow(/Avro binary codec/);
  });
  it("admits JSON media (the Avro-JSON wire)", () => {
    expect(() => avroMediaGuard(avroMessage, "application/json")).not.toThrow();
  });
  it("never trips for a non-Avro payload", () => {
    expect(() => avroMediaGuard({ payload: { type: "object" } }, "avro/binary")).not.toThrow();
  });
});

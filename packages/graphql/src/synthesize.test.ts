import { describe, expect, it } from "vitest";
import type { IntrospectionSchema } from "./introspection.js";
import { convertToInterface } from "./synthesize.js";
import { BINDING_SPEC } from "./constants.js";

const schema: IntrospectionSchema = {
  queryType: { kind: "OBJECT", name: "ReadRoot", ofType: null },
  mutationType: { kind: "OBJECT", name: "WriteRoot", ofType: null },
  subscriptionType: { kind: "OBJECT", name: "StreamRoot", ofType: null },
  types: [
    {
      kind: "OBJECT",
      name: "ReadRoot",
      fields: [
        { name: "status", args: [], type: { kind: "SCALAR", name: "String", ofType: null }, isDeprecated: false },
        { name: "viewer", description: "Current viewer", args: [], type: { kind: "OBJECT", name: "User", ofType: null }, isDeprecated: false },
      ],
    },
    {
      kind: "OBJECT",
      name: "WriteRoot",
      fields: [
        { name: "status", args: [], type: { kind: "SCALAR", name: "String", ofType: null }, isDeprecated: false },
      ],
    },
    {
      kind: "OBJECT",
      name: "StreamRoot",
      fields: [
        { name: "status", args: [], type: { kind: "SCALAR", name: "String", ofType: null }, isDeprecated: false },
      ],
    },
    { kind: "OBJECT", name: "User", fields: [] },
    { kind: "SCALAR", name: "String" },
  ],
};

describe("convertToInterface", () => {
  it("represents eligible query and mutation root fields with canonical refs and stable collisions", () => {
    const iface = convertToInterface(schema, "https://api.example.test/graphql");

    expect(Object.keys(iface.operations).sort()).toEqual([
      "mutation_status",
      "status",
      "viewer",
    ]);
    expect(Object.values(iface.bindings ?? {}).map((binding) => binding.ref).sort()).toEqual([
      "mutation/status",
      "query/status",
      "query/viewer",
    ]);
    expect(iface.sources?.graphql).toEqual({
      bindingSpec: BINDING_SPEC,
      location: "https://api.example.test/graphql",
    });
  });

  it("uses the application root-value schema instead of inventing a document projection", () => {
    const iface = convertToInterface(schema);
    const operation = iface.operations.viewer!;
    expect(operation.input).toEqual({ type: "object" });
    expect(operation.output).toEqual({ anyOf: [{ type: "object" }, { type: "null" }] });
    expect(JSON.stringify(operation)).not.toContain("_query");
    expect(JSON.stringify(operation.output)).not.toContain("viewer");
  });

  it("preserves descriptions and deprecation without projecting return selections", () => {
    const changed: IntrospectionSchema = structuredClone(schema);
    changed.types[0]!.fields![1]!.isDeprecated = true;
    const operation = convertToInterface(changed).operations.viewer!;
    expect(operation.description).toBe("Current viewer");
    expect(operation.deprecated).toBe(true);
  });

  it("projects root-field schemas and excludes subscriptions in the first-revision candidate", () => {
    const iface = convertToInterface(schema, undefined, BINDING_SPEC);
    expect(iface.operations).not.toHaveProperty("subscription_status");
    expect(iface.operations.status?.output).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
  });
});

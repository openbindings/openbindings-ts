import { describe, it, expect } from "vitest";
import { convertToInterface } from "./create.js";
import type { IntrospectionSchema } from "./introspection.js";

describe("convertToInterface", () => {
  it("converts query fields to operations with _query const", () => {
    const schema: IntrospectionSchema = {
      queryType: { kind: "OBJECT", name: "Query", ofType: null },
      mutationType: null,
      subscriptionType: null,
      types: [
        {
          kind: "OBJECT", name: "Query",
          fields: [{
            name: "users",
            description: "List all users",
            args: [],
            type: { kind: "LIST", name: null, ofType: { kind: "OBJECT", name: "User", ofType: null } },
            isDeprecated: false,
          }],
        },
        {
          kind: "OBJECT", name: "User",
          fields: [
            { name: "id", type: { kind: "SCALAR", name: "ID", ofType: null }, args: [], isDeprecated: false },
            { name: "name", type: { kind: "SCALAR", name: "String", ofType: null }, args: [], isDeprecated: false },
          ],
        },
      ],
    };

    const iface = convertToInterface(schema, "https://api.example.com/graphql");

    expect(Object.keys(iface.operations)).toEqual(["users"]);
    expect(iface.operations.users.description).toBe("List all users");

    // Should have _query const in input schema.
    const input = iface.operations.users.input as Record<string, unknown>;
    const props = input.properties as Record<string, unknown>;
    const queryProp = props._query as Record<string, unknown>;
    expect(queryProp.const).toContain("users");
    expect(queryProp.const).toContain("{ id name }");

    const binding = iface.bindings!["users.graphql"];
    expect(binding.ref).toBe("Query/users");
    expect(binding.source).toBe("graphql");

    expect(iface.sources!.graphql.location).toBe("https://api.example.com/graphql");
  });

  it("converts mutations", () => {
    const schema: IntrospectionSchema = {
      queryType: { kind: "OBJECT", name: "Query", ofType: null },
      mutationType: { kind: "OBJECT", name: "Mutation", ofType: null },
      subscriptionType: null,
      types: [
        { kind: "OBJECT", name: "Query", fields: [] },
        {
          kind: "OBJECT", name: "Mutation",
          fields: [{
            name: "deleteUser",
            description: "Delete a user",
            args: [{ name: "id", type: { kind: "NON_NULL", name: null, ofType: { kind: "SCALAR", name: "ID", ofType: null } } }],
            type: { kind: "SCALAR", name: "Boolean", ofType: null },
            isDeprecated: true,
          }],
        },
      ],
    };

    const iface = convertToInterface(schema);
    const op = iface.operations.deleteUser;
    expect(op.deprecated).toBe(true);

    const input = op.input as Record<string, unknown>;
    expect((input.required as string[]).includes("id")).toBe(true);

    expect(iface.bindings!["deleteUser.graphql"].ref).toBe("Mutation/deleteUser");
  });

  it("handles key collisions across root types", () => {
    const schema: IntrospectionSchema = {
      queryType: { kind: "OBJECT", name: "Query", ofType: null },
      mutationType: { kind: "OBJECT", name: "Mutation", ofType: null },
      subscriptionType: null,
      types: [
        {
          kind: "OBJECT", name: "Query",
          fields: [{ name: "status", args: [], type: { kind: "SCALAR", name: "String", ofType: null }, isDeprecated: false }],
        },
        {
          kind: "OBJECT", name: "Mutation",
          fields: [{ name: "status", args: [], type: { kind: "SCALAR", name: "String", ofType: null }, isDeprecated: false }],
        },
      ],
    };

    const iface = convertToInterface(schema);
    expect(Object.keys(iface.operations)).toHaveLength(2);
    expect(iface.operations.status).toBeDefined();
    expect(iface.operations.mutation_status).toBeDefined();
  });

  it("sorts fields alphabetically", () => {
    const schema: IntrospectionSchema = {
      queryType: { kind: "OBJECT", name: "Query", ofType: null },
      mutationType: null,
      subscriptionType: null,
      types: [{
        kind: "OBJECT", name: "Query",
        fields: [
          { name: "zebra", args: [], type: { kind: "SCALAR", name: "String", ofType: null }, isDeprecated: false },
          { name: "alpha", args: [], type: { kind: "SCALAR", name: "String", ofType: null }, isDeprecated: false },
          { name: "middle", args: [], type: { kind: "SCALAR", name: "String", ofType: null }, isDeprecated: false },
        ],
      }],
    };

    const iface = convertToInterface(schema);
    expect(Object.keys(iface.operations)).toEqual(["alpha", "middle", "zebra"]);
  });

  it("maps enum types to JSON Schema", () => {
    const schema: IntrospectionSchema = {
      queryType: { kind: "OBJECT", name: "Query", ofType: null },
      mutationType: null,
      subscriptionType: null,
      types: [
        {
          kind: "OBJECT", name: "Query",
          fields: [{ name: "status", args: [], type: { kind: "ENUM", name: "Status", ofType: null }, isDeprecated: false }],
        },
        {
          kind: "ENUM", name: "Status",
          enumValues: [{ name: "ACTIVE", isDeprecated: false }, { name: "INACTIVE", isDeprecated: false }],
        },
      ],
    };

    const iface = convertToInterface(schema);
    const output = iface.operations.status.output as Record<string, unknown>;
    expect(output.type).toBe("string");
    expect(output.enum).toEqual(["ACTIVE", "INACTIVE"]);
  });
});

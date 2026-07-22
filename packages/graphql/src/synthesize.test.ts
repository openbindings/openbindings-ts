import { describe, it, expect } from "vitest";
import { convertToInterface, sanitizeKey } from "./synthesize.js";
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
    expect(iface.operations.users?.description).toBe("List all users");

    // Should have _query const in input schema.
    const input = iface.operations.users?.input as Record<string, unknown>;
    const props = input.properties as Record<string, unknown>;
    const queryProp = props._query as Record<string, unknown>;
    expect(queryProp.const).toContain("users");
    expect(queryProp.const).toContain("{ id name }");

    const binding = iface.bindings?.["users.graphql"];
    expect(binding?.ref).toBe("Query/users");
    expect(binding?.source).toBe("graphql");

    expect(iface.sources?.graphql?.location).toBe("https://api.example.com/graphql");
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
    expect(op?.deprecated).toBe(true);

    const input = op?.input as Record<string, unknown>;
    expect((input.required as string[]).includes("id")).toBe(true);

    expect(iface.bindings?.["deleteUser.graphql"]?.ref).toBe("Mutation/deleteUser");
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
    const output = iface.operations.status?.output as Record<string, unknown>;
    expect(output.type).toBe("string");
    expect(output.enum).toEqual(["ACTIVE", "INACTIVE"]);
  });
});

// ---------------------------------------------------------------------------
// Shared-type (DAG reuse) synthesis — C8f
//
// A type reused in sibling (non-cyclic) positions must carry the full schema in
// EVERY position, not collapse to a bare {"type":"object"} after the first. A
// true cycle must still terminate as a bare placeholder. These mirror the Go
// graphql module's synthesize_shared_test.go, and the object case is pinned to
// the same canonical literal so Go≡TS output is asserted on both sides.
// ---------------------------------------------------------------------------

// Canonical (recursively sorted-key) JSON, comparable byte-for-byte with Go's
// encoding/json (which sorts map keys by default).
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}
function canonicalize(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

// The exact canonical schema both SDKs must emit for `User { id: ID, name:
// String }` in a shared position. The Go test asserts against this same
// literal (parityPinnedUserSchema).
const PARITY_PINNED_USER_SCHEMA =
  '{"properties":{"id":{"type":"string"},"name":{"type":"string"}},"type":"object"}';

describe("convertToInterface — shared-type synthesis (C8f)", () => {
  it("does not truncate an object type reused in sibling positions", () => {
    const schema: IntrospectionSchema = {
      queryType: { kind: "OBJECT", name: "Query", ofType: null },
      mutationType: null,
      subscriptionType: null,
      types: [
        {
          kind: "OBJECT", name: "Query",
          fields: [{ name: "search", args: [], type: { kind: "OBJECT", name: "SearchPayload", ofType: null }, isDeprecated: false }],
        },
        {
          kind: "OBJECT", name: "SearchPayload",
          fields: [
            { name: "primary", args: [], type: { kind: "OBJECT", name: "User", ofType: null }, isDeprecated: false },
            { name: "secondary", args: [], type: { kind: "OBJECT", name: "User", ofType: null }, isDeprecated: false },
          ],
        },
        {
          kind: "OBJECT", name: "User",
          fields: [
            { name: "id", args: [], type: { kind: "SCALAR", name: "ID", ofType: null }, isDeprecated: false },
            { name: "name", args: [], type: { kind: "SCALAR", name: "String", ofType: null }, isDeprecated: false },
          ],
        },
      ],
    };

    const iface = convertToInterface(schema);
    const output = iface.operations.search?.output as Record<string, unknown>;
    const props = output.properties as Record<string, Record<string, unknown>>;

    for (const fieldName of ["primary", "secondary"]) {
      const f = props[fieldName];
      expect(f?.properties, `field ${fieldName} truncated to a bare object`).toBeDefined();
      expect((f?.properties as Record<string, unknown>).name).toBeDefined();
      // Parity pin: the same canonical literal the Go test asserts.
      expect(canonicalize(f)).toBe(PARITY_PINNED_USER_SCHEMA);
    }
  });

  it("does not truncate an input-object type reused in sibling input positions", () => {
    const schema: IntrospectionSchema = {
      queryType: { kind: "OBJECT", name: "Query", ofType: null },
      mutationType: { kind: "OBJECT", name: "Mutation", ofType: null },
      subscriptionType: null,
      types: [
        { kind: "OBJECT", name: "Query", fields: [] },
        {
          kind: "OBJECT", name: "Mutation",
          fields: [{
            name: "createPair",
            args: [{ name: "input", type: { kind: "INPUT_OBJECT", name: "Pair", ofType: null } }],
            type: { kind: "SCALAR", name: "Boolean", ofType: null },
            isDeprecated: false,
          }],
        },
        {
          kind: "INPUT_OBJECT", name: "Pair",
          inputFields: [
            { name: "a", type: { kind: "INPUT_OBJECT", name: "Point", ofType: null } },
            { name: "b", type: { kind: "INPUT_OBJECT", name: "Point", ofType: null } },
          ],
        },
        {
          kind: "INPUT_OBJECT", name: "Point",
          inputFields: [{ name: "label", type: { kind: "SCALAR", name: "String", ofType: null } }],
        },
      ],
    };

    const iface = convertToInterface(schema);
    const input = iface.operations.createPair?.input as Record<string, unknown>;
    const pair = (input.properties as Record<string, Record<string, unknown>>).input;
    const pairProps = pair?.properties as Record<string, Record<string, unknown>>;

    for (const fieldName of ["a", "b"]) {
      const f = pairProps[fieldName];
      expect(f?.properties, `input field ${fieldName} truncated to a bare object`).toBeDefined();
      expect((f?.properties as Record<string, unknown>).label).toBeDefined();
    }
  });

  it("preserves the bare placeholder for a true cycle", () => {
    const schema: IntrospectionSchema = {
      queryType: { kind: "OBJECT", name: "Query", ofType: null },
      mutationType: null,
      subscriptionType: null,
      types: [
        {
          kind: "OBJECT", name: "Query",
          fields: [{ name: "node", args: [], type: { kind: "OBJECT", name: "Node", ofType: null }, isDeprecated: false }],
        },
        {
          kind: "OBJECT", name: "Node",
          fields: [
            { name: "id", args: [], type: { kind: "SCALAR", name: "ID", ofType: null }, isDeprecated: false },
            { name: "parent", args: [], type: { kind: "OBJECT", name: "Node", ofType: null }, isDeprecated: false },
          ],
        },
      ],
    };

    const iface = convertToInterface(schema);
    const output = iface.operations.node?.output as Record<string, unknown>;
    const parent = (output.properties as Record<string, Record<string, unknown>>).parent;
    expect(parent).toBeDefined();
    expect(parent?.type).toBe("object");
    expect(parent?.properties).toBeUndefined();
  });
});

describe("deterministic ordering", () => {
  it("orders mixed-case field names by code point, not locale collation", () => {
    const schema: IntrospectionSchema = {
      queryType: { kind: "OBJECT", name: "Query", ofType: null },
      mutationType: null,
      subscriptionType: null,
      types: [
        {
          kind: "OBJECT", name: "Query",
          fields: [
            { name: "alpha", type: { kind: "SCALAR", name: "String", ofType: null }, args: [], isDeprecated: false },
            { name: "Bravo", type: { kind: "SCALAR", name: "String", ofType: null }, args: [], isDeprecated: false },
          ],
        },
      ],
    };

    const iface = convertToInterface(schema);

    // "B" (U+0042) < "a" (U+0061) by code point — the order Go's byte-wise
    // comparison produces; ICU locale collation would flip the pair.
    expect(Object.keys(iface.operations)).toEqual(["Bravo", "alpha"]);
  });

  it("sanitizes an astral-plane character to one underscore, not one per surrogate half", () => {
    expect(sanitizeKey("t-😀-a")).toBe("t-_-a");
  });
});

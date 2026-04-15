import { describe, it, expect } from "vitest";
import { parseRef, typeRefToGraphQL, buildSelectionSet, buildQueryFromIntrospection, queryFromSchema, parseIntrospectionContent } from "./execute.js";
import type { IntrospectionSchema, FullType, TypeMap } from "./introspection.js";

describe("parseRef", () => {
  it("parses query ref", () => {
    expect(parseRef("Query/users")).toEqual({ rootType: "Query", fieldName: "users" });
  });
  it("parses mutation ref", () => {
    expect(parseRef("Mutation/createUser")).toEqual({ rootType: "Mutation", fieldName: "createUser" });
  });
  it("parses subscription ref", () => {
    expect(parseRef("Subscription/onOrder")).toEqual({ rootType: "Subscription", fieldName: "onOrder" });
  });
  it("rejects empty", () => {
    expect(() => parseRef("")).toThrow();
  });
  it("rejects no slash", () => {
    expect(() => parseRef("QueryUsers")).toThrow();
  });
  it("rejects invalid root", () => {
    expect(() => parseRef("Invalid/users")).toThrow(/invalid root type/);
  });
  it("rejects trailing slash", () => {
    expect(() => parseRef("Query/")).toThrow();
  });
  it("rejects lowercase root", () => {
    expect(() => parseRef("query/users")).toThrow(/invalid root type/);
  });
});

describe("typeRefToGraphQL", () => {
  it("scalar", () => {
    expect(typeRefToGraphQL({ kind: "SCALAR", name: "String", ofType: null })).toBe("String");
  });
  it("non-null scalar", () => {
    expect(typeRefToGraphQL({ kind: "NON_NULL", name: null, ofType: { kind: "SCALAR", name: "ID", ofType: null } })).toBe("ID!");
  });
  it("list", () => {
    expect(typeRefToGraphQL({ kind: "LIST", name: null, ofType: { kind: "SCALAR", name: "String", ofType: null } })).toBe("[String]");
  });
  it("non-null list of non-null", () => {
    expect(typeRefToGraphQL({
      kind: "NON_NULL", name: null, ofType: {
        kind: "LIST", name: null, ofType: {
          kind: "NON_NULL", name: null, ofType: { kind: "SCALAR", name: "Int", ofType: null },
        },
      },
    })).toBe("[Int!]!");
  });
});

describe("buildSelectionSet", () => {
  const makeTM = (types: FullType[]): TypeMap => new Map(types.map((t) => [t.name, t]));

  it("flat object", () => {
    const tm = makeTM([{
      kind: "OBJECT", name: "User",
      fields: [
        { name: "id", type: { kind: "SCALAR", name: "ID", ofType: null }, args: [], isDeprecated: false },
        { name: "name", type: { kind: "SCALAR", name: "String", ofType: null }, args: [], isDeprecated: false },
      ],
    }]);
    expect(buildSelectionSet("User", tm, 0, new Set())).toBe("{ id name }");
  });

  it("nested object", () => {
    const tm = makeTM([
      {
        kind: "OBJECT", name: "User",
        fields: [
          { name: "id", type: { kind: "SCALAR", name: "ID", ofType: null }, args: [], isDeprecated: false },
          { name: "posts", type: { kind: "LIST", name: null, ofType: { kind: "OBJECT", name: "Post", ofType: null } }, args: [], isDeprecated: false },
        ],
      },
      {
        kind: "OBJECT", name: "Post",
        fields: [
          { name: "title", type: { kind: "SCALAR", name: "String", ofType: null }, args: [], isDeprecated: false },
        ],
      },
    ]);
    expect(buildSelectionSet("User", tm, 0, new Set())).toBe("{ id posts { title } }");
  });

  it("cycle detection", () => {
    const tm = makeTM([{
      kind: "OBJECT", name: "User",
      fields: [
        { name: "id", type: { kind: "SCALAR", name: "ID", ofType: null }, args: [], isDeprecated: false },
        { name: "friends", type: { kind: "LIST", name: null, ofType: { kind: "OBJECT", name: "User", ofType: null } }, args: [], isDeprecated: false },
      ],
    }]);
    expect(buildSelectionSet("User", tm, 0, new Set())).toBe("{ id }");
  });

  it("depth limit", () => {
    const tm = makeTM([
      { kind: "OBJECT", name: "A", fields: [
        { name: "a_val", type: { kind: "SCALAR", name: "String", ofType: null }, args: [], isDeprecated: false },
        { name: "b", type: { kind: "OBJECT", name: "B", ofType: null }, args: [], isDeprecated: false },
      ] },
      { kind: "OBJECT", name: "B", fields: [
        { name: "b_val", type: { kind: "SCALAR", name: "String", ofType: null }, args: [], isDeprecated: false },
        { name: "c", type: { kind: "OBJECT", name: "C", ofType: null }, args: [], isDeprecated: false },
      ] },
      { kind: "OBJECT", name: "C", fields: [
        { name: "c_val", type: { kind: "SCALAR", name: "String", ofType: null }, args: [], isDeprecated: false },
        { name: "d", type: { kind: "OBJECT", name: "D", ofType: null }, args: [], isDeprecated: false },
      ] },
      { kind: "OBJECT", name: "D", fields: [
        { name: "value", type: { kind: "SCALAR", name: "String", ofType: null }, args: [], isDeprecated: false },
      ] },
    ]);
    expect(buildSelectionSet("A", tm, 0, new Set())).toBe("{ a_val b { b_val c { c_val } } }");
  });

  it("union with inline fragments", () => {
    const tm = makeTM([
      { kind: "UNION", name: "SearchResult", possibleTypes: [{ kind: "OBJECT", name: "User", ofType: null }, { kind: "OBJECT", name: "Post", ofType: null }] },
      { kind: "OBJECT", name: "User", fields: [{ name: "name", type: { kind: "SCALAR", name: "String", ofType: null }, args: [], isDeprecated: false }] },
      { kind: "OBJECT", name: "Post", fields: [{ name: "title", type: { kind: "SCALAR", name: "String", ofType: null }, args: [], isDeprecated: false }] },
    ]);
    expect(buildSelectionSet("SearchResult", tm, 0, new Set())).toBe("{ __typename ... on User { name } ... on Post { title } }");
  });
});

describe("buildQueryFromIntrospection", () => {
  it("builds query with variables and selection set", () => {
    const schema: IntrospectionSchema = {
      queryType: { kind: "OBJECT", name: "Query", ofType: null },
      mutationType: null,
      subscriptionType: null,
      types: [
        {
          kind: "OBJECT", name: "Query",
          fields: [{
            name: "user",
            args: [{ name: "id", type: { kind: "NON_NULL", name: null, ofType: { kind: "SCALAR", name: "ID", ofType: null } } }],
            type: { kind: "OBJECT", name: "User", ofType: null },
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

    const { query, variables } = buildQueryFromIntrospection(schema, "Query", "user", { id: "123" });
    expect(query).toBe("query($id: ID!) { user(id: $id) { id name } }");
    expect(variables).toEqual({ id: "123" });
  });
});

describe("queryFromSchema", () => {
  it("returns null for undefined schema", () => {
    expect(queryFromSchema(undefined)).toBeNull();
  });
  it("returns null for schema without _query", () => {
    expect(queryFromSchema({ type: "object", properties: { id: { type: "string" } } })).toBeNull();
  });
  it("returns null for _query without const", () => {
    expect(queryFromSchema({ type: "object", properties: { _query: { type: "string" } } })).toBeNull();
  });
  it("returns const value", () => {
    expect(queryFromSchema({
      type: "object",
      properties: { _query: { type: "string", const: "query { users { id } }" } },
    })).toBe("query { users { id } }");
  });
});

describe("parseIntrospectionContent", () => {
  const minimalSchema = {
    queryType: { kind: "OBJECT", name: "Query", ofType: null },
    mutationType: null,
    subscriptionType: null,
    types: [],
  };

  it("parses full response shape", () => {
    const result = parseIntrospectionContent({ data: { __schema: minimalSchema } });
    expect(result.queryType?.name).toBe("Query");
  });

  it("parses __schema wrapper", () => {
    const result = parseIntrospectionContent({ __schema: minimalSchema });
    expect(result.queryType?.name).toBe("Query");
  });

  it("parses bare schema", () => {
    const result = parseIntrospectionContent(minimalSchema);
    expect(result.queryType?.name).toBe("Query");
  });

  it("parses JSON string", () => {
    const result = parseIntrospectionContent(JSON.stringify({ data: { __schema: minimalSchema } }));
    expect(result.queryType?.name).toBe("Query");
  });

  it("rejects invalid content", () => {
    expect(() => parseIntrospectionContent("not json")).toThrow(/unrecognized/);
  });

  it("rejects null", () => {
    expect(() => parseIntrospectionContent(null)).toThrow(/unrecognized/);
  });

  it("rejects empty object", () => {
    expect(() => parseIntrospectionContent({})).toThrow(/unrecognized/);
  });
});

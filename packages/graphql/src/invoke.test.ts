import { describe, expect, it } from "vitest";
import { parseExecutableDocument } from "./document.js";
import {
  parseIntrospectionContent,
  parseSelector,
  wellFormedGraphQLResponse,
} from "./invoke.js";
import type { IntrospectionSchema } from "./introspection.js";

const schema: IntrospectionSchema = {
  queryType: { kind: "OBJECT", name: "RootQuery", ofType: null },
  mutationType: { kind: "OBJECT", name: "RootMutation", ofType: null },
  subscriptionType: null,
  types: [
    {
      kind: "OBJECT",
      name: "RootQuery",
      fields: [
        { name: "viewer", args: [], type: { kind: "SCALAR", name: "String", ofType: null }, isDeprecated: false },
        { name: "health", args: [], type: { kind: "SCALAR", name: "String", ofType: null }, isDeprecated: false },
      ],
    },
    {
      kind: "OBJECT",
      name: "RootMutation",
      fields: [
        { name: "save", args: [], type: { kind: "SCALAR", name: "String", ofType: null }, isDeprecated: false },
      ],
    },
    { kind: "SCALAR", name: "String" },
  ],
};

describe("parseSelector", () => {
  it.each([
    ["query/viewer", { rootType: "query", fieldName: "viewer" }],
    ["mutation/save", { rootType: "mutation", fieldName: "save" }],
    ["subscription/updates", { rootType: "subscription", fieldName: "updates" }],
  ])("accepts %s", (selector, expected) => expect(parseSelector(selector)).toEqual(expected));

  it.each(["Query/viewer", "query/", "query/viewer/nested", "query/not-valid", ""])(
    "rejects noncanonical %s",
    (selector) => expect(() => parseSelector(selector)).toThrow(),
  );
});

describe("executable document correspondence", () => {
  it("selects a named operation and follows root fragments and aliases", () => {
    const doc = parseExecutableDocument(`
      query Other { health }
      query Viewer($skip: Boolean!) {
        ...RootFields
      }
      fragment RootFields on RootQuery {
        result: viewer @skip(if: $skip)
        health @include(if: $skip)
      }
    `);
    expect(() => doc.verifySelection("Viewer", "query", "viewer", { skip: false }, schema)).not.toThrow();
  });

  it("refuses operation-kind, multi-root, and root-field mismatches", () => {
    expect(() => parseExecutableDocument("mutation { save }").verifySelection(undefined, "query", "save", {}, schema)).toThrow(/kind/);
    expect(() => parseExecutableDocument("{ viewer health }").verifySelection(undefined, "query", "viewer", {}, schema)).toThrow(/exactly one/);
    expect(() => parseExecutableDocument("{ health }").verifySelection(undefined, "query", "viewer", {}, schema)).toThrow(/does not match/);
  });

  it("requires operationName for a multi-operation document", () => {
    const doc = parseExecutableDocument("query A { viewer } query B { health }");
    expect(() => doc.verifySelection(undefined, "query", "viewer", {}, schema)).toThrow(/operationName/);
  });

  it.each([
    "query Viewer() { viewer }",
    "query Viewer($id) { viewer(id: $id) }",
    "query Viewer($id: ID = $other) { viewer }",
    "query { viewer() }",
    "query { viewer(id) }",
    "query { viewer(filter: {id}) }",
    "query { viewer(limit: 01) }",
    String.raw`query { viewer(arg: "bad\q") }`,
    "query { éxample }",
  ])("rejects malformed GraphQL syntax: %s", (source) => {
    expect(() => parseExecutableDocument(source)).toThrow();
  });

  it.each([
    String.raw`query { viewer(arg: "\u{1F4A9}") }`,
    String.raw`query { viewer(arg: """embedded \""" triple quote""") }`,
  ])("accepts GraphQL string syntax: %s", (source) => {
    const document = parseExecutableDocument(source);
    expect(() => document.verifySelection(undefined, "query", "viewer", {}, schema)).not.toThrow();
  });
});

describe("parseIntrospectionContent", () => {
  const successful = { data: { __schema: schema } };

  it("accepts only a successful execution-result object", () => {
    expect(parseIntrospectionContent(successful).queryType?.name).toBe("RootQuery");
  });

  it.each([
    { __schema: schema },
    schema,
    JSON.stringify(successful),
    { data: { __schema: schema }, errors: [] },
    null,
  ])("rejects noncanonical content %#", (content) => {
    expect(() => parseIntrospectionContent(content)).toThrow();
  });
});

describe("GraphQL response envelope", () => {
  it.each([
    { data: { viewer: "Ada" } },
    { data: null, errors: [{ message: "failed" }] },
    { errors: [{ message: "request rejected" }] },
  ])("accepts well-formed response %#", (value) => {
    expect(wellFormedGraphQLResponse(value)).toBe(true);
  });

  it.each([
    {},
    { data: "not an object" },
    { errors: [] },
    { errors: [{ code: "NO_MESSAGE" }] },
  ])("rejects malformed response %#", (value) => {
    expect(wellFormedGraphQLResponse(value)).toBe(false);
  });
});

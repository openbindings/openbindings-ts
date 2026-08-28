import { describe, expect, it } from "vitest";
import {
  BINDING_SPEC_OPENAPI_30,
  BINDING_SPEC_OPENAPI_31,
  BINDING_SPEC_OPENAPI_32,
} from "./constants.js";
import { OpenAPIInvoker } from "./invoker.js";
import {
  checkPathTemplateDeclaration,
  convertParameterScalars,
  effectiveParameterDeclarationRows,
  equivalentPathTemplateCollision,
  formStyleCookieMultiValueProof,
  malformedEffectiveParameter,
  prepareSchemaParameterValue,
  sourceExclusionReason,
} from "./parameter-semantics.js";

describe("OpenAPI parameter semantics", () => {
  it("requires and recursively applies parameterConversion", () => {
    const value = { flag: true, list: [2.5, "already-text"] };
    expect(() => convertParameterScalars(value, undefined)).toThrow(/parameterConversion/);
    expect(convertParameterScalars(value, (member) => `configured<${member}>`)).toEqual({
      flag: "configured<true>",
      list: ["configured<2.5>", "already-text"],
    });
  });

  it("converges 3.0 scalar conversion and member-null refusal", () => {
    const parameter = {
      name: "q",
      in: "query",
      schema: { type: "array", items: { type: "integer" } },
    };
    expect(() => prepareSchemaParameterValue(
      parameter,
      [7],
      BINDING_SPEC_OPENAPI_30,
      undefined,
    )).toThrow(/parameterConversion/);
    expect(prepareSchemaParameterValue(
      parameter,
      [7],
      BINDING_SPEC_OPENAPI_30,
      (value) => `configured<${value}>`,
    ).value).toEqual(["configured<7>"]);
    expect(() => prepareSchemaParameterValue(
      parameter,
      [7, null],
      BINDING_SPEC_OPENAPI_30,
      String,
    )).toThrow(/null array\/object member/);
  });

  it("refuses member nulls, non-RFC delimiters, and invalid header bytes", () => {
    expect(() => convertParameterScalars(["ok", null], undefined)).toThrow(/null/);
    expect(() => prepareSchemaParameterValue({
      name: "filter",
      in: "query",
      style: "deepObject",
      explode: true,
      schema: {},
    }, { kind: "a&b" }, BINDING_SPEC_OPENAPI_31, undefined)).toThrow(/structural delimiter/);
    expect(() => prepareSchemaParameterValue({
      name: "X-Test",
      in: "header",
      schema: { type: "string" },
    }, "safe\r\nInjected: yes", BINDING_SPEC_OPENAPI_31, undefined)).toThrow(/invalid HTTP field byte/);
  });

  it("uses the corrected whole-null cells and refuses n/a cells on both siblings", () => {
    for (const bindingSpec of [BINDING_SPEC_OPENAPI_30, BINDING_SPEC_OPENAPI_31]) {
      expect(prepareSchemaParameterValue({
        name: "q",
        in: "query",
        style: "form",
        schema: {},
      }, null, bindingSpec, undefined).value).toBeNull();
      expect(() => prepareSchemaParameterValue({
        name: "q",
        in: "query",
        style: "spaceDelimited",
        explode: false,
        schema: {},
      }, null, bindingSpec, undefined)).toThrow(/undefined cell/);
    }
  });

  it("distinguishes cookie static proof from runtime multi-pair proof", () => {
    const array = {
      name: "parts",
      in: "cookie",
      style: "form",
      explode: true,
      schema: { type: "array", items: { type: "string" } },
    };
    const typeless = { ...array, schema: {} };
    const arrayOrNull = { ...array, schema: { type: ["array", "null"] } };
    expect(formStyleCookieMultiValueProof(array, false)).toBe(true);
    expect(formStyleCookieMultiValueProof(typeless, false)).toBe(false);
    expect(formStyleCookieMultiValueProof(arrayOrNull, false)).toBe(false);
    expect(formStyleCookieMultiValueProof(array, true)).toBe(true);
    for (const bindingSpec of [BINDING_SPEC_OPENAPI_30, BINDING_SPEC_OPENAPI_31]) {
      expect(() => prepareSchemaParameterValue(
        typeless,
        ["a", "b"],
        bindingSpec,
        undefined,
      )).toThrow(/multiple cookie pairs/);
    }
  });

  it("uses the document's explode=true default for explicit 3.2 cookie style", async () => {
    const requests: Array<{ url: string; cookie: string | null }> = [];
    const spec = operationDocument("get", {
      parameters: [{
        name: "parts",
        in: "cookie",
        style: "cookie",
        schema: { type: "array", items: { type: "string" } },
      }],
    }, "3.2.0");
    const call = new OpenAPIInvoker().invokeBinding({
      source: { bindingSpec: BINDING_SPEC_OPENAPI_32, content: spec },
      selector: "#/paths/~1x/get",
      fetch: async (input, init) => {
        requests.push({
          url: input instanceof Request ? input.url : String(input),
          cookie: new Headers(init?.headers).get("Cookie"),
        });
        return new Response(null, { status: 204 });
      },
    });
    await call.write({ parameters: { parts: ["a", "b"] } });
    await call.closed;
    expect(requests).toEqual([{
      url: "https://api.example.test/x",
      cookie: "parts=a; parts=b",
    }]);
  });

  it("enforces sibling path correspondence without importing 3.1 ambiguity rules into 3.0", () => {
    const pathParameter = (name: string) => ({ name, in: "path", required: true, schema: {} });
    expect(checkPathTemplateDeclaration("/items", [pathParameter("id")], BINDING_SPEC_OPENAPI_31))
      .toMatch(/no path template expression/);
    expect(checkPathTemplateDeclaration("/{id}/{id}", [pathParameter("id")], BINDING_SPEC_OPENAPI_31))
      .toMatch(/more than once/);
    expect(checkPathTemplateDeclaration("/items", [pathParameter("id")], BINDING_SPEC_OPENAPI_30))
      .toMatch(/no path template expression/);
    expect(checkPathTemplateDeclaration("/{id}/{id}", [pathParameter("id")], BINDING_SPEC_OPENAPI_30))
      .toBeUndefined();
    expect(equivalentPathTemplateCollision({
      "/items/{id}": {},
      "/items/{name}": {},
    }, "/items/{id}")).toBe("/items/{name}");
  });

  it("keeps both declaration gates closed without guessing unknown fields", () => {
    const malformed = [{
      name: "q",
      in: "query",
      schema: {},
      content: { "application/json": {} },
    }];
    expect(malformedEffectiveParameter(malformed, BINDING_SPEC_OPENAPI_31)).toBe("q");
    expect(malformedEffectiveParameter([
      { name: "q", in: "query", schema: {}, futureKeyword: true },
    ], BINDING_SPEC_OPENAPI_31)).toBeUndefined();
    expect(malformedEffectiveParameter(malformed, BINDING_SPEC_OPENAPI_30)).toBe("q");

    const rows = effectiveParameterDeclarationRows(
      { parameters: [{ name: "q", in: "query", schema: {} }] },
      { parameters: [{ name: "q", in: "query", content: { "text/plain": {} } }] },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty("content");
  });

  it("classifies a custom root dialect as source exclusion, not load refusal", () => {
    expect(sourceExclusionReason({
      openapi: "3.1.2",
      jsonSchemaDialect: "https://example.test/custom",
    }, BINDING_SPEC_OPENAPI_31)).toMatch(/whole-source exclusion/);
    expect(sourceExclusionReason({
      openapi: "3.1.2",
      jsonSchemaDialect: "https://spec.openapis.org/oas/3.1/dialect/base",
    }, BINDING_SPEC_OPENAPI_31)).toBeUndefined();
  });

  it("uses the configured number spelling at the runtime boundary", async () => {
    const requests: string[] = [];
    const spec = operationDocument("get", {
      parameters: [{ name: "q", in: "query", schema: { type: "number" } }],
    });
    const call = new OpenAPIInvoker({
      parameterConversion: () => "configured-seven",
    }).invokeBinding({
      source: { bindingSpec: BINDING_SPEC_OPENAPI_31, content: spec },
      selector: "#/paths/~1x/get",
      fetch: async (input) => {
        requests.push(input instanceof Request ? input.url : String(input));
        return new Response(null, { status: 204 });
      },
    });
    await call.write({ parameters: { q: 7 } });
    await call.closed;
    expect(requests).toEqual(["https://api.example.test/x?q=configured-seven"]);
  });

  it("applies conversion recursively on an Encoding style path", async () => {
    let body: BodyInit | null | undefined;
    const spec = operationDocument("post", {
      requestBody: {
        required: true,
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              type: "object",
              properties: {
                filter: {
                  type: "object",
                  properties: { a: { type: "number" }, b: { type: "string" } },
                },
              },
            },
            encoding: { filter: { style: "pipeDelimited", explode: false } },
          },
        },
      },
    });
    const call = new OpenAPIInvoker({
      parameterConversion: () => "configured-seven",
    }).invokeBinding({
      source: { bindingSpec: BINDING_SPEC_OPENAPI_31, content: spec },
      selector: "#/paths/~1x/post",
      fetch: async (_input, init) => {
        body = init?.body;
        return new Response(null, { status: 204 });
      },
    });
    await call.write({ body: { filter: { a: 7, b: "two" } } });
    await call.closed;
    expect(body).toBe("filter=a|configured-seven|b|two");
  });

  it("applies configured 3.0 conversion on the content-based form path", async () => {
    let body: BodyInit | null | undefined;
    const spec = {
      openapi: "3.0.4",
      info: { title: "content-form conversion", version: "1" },
      servers: [{ url: "https://api.example.test" }],
      paths: {
        "/x": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/x-www-form-urlencoded": {
                  schema: {
                    type: "object",
                    properties: { count: { type: "integer" } },
                  },
                },
              },
            },
            responses: { "204": { description: "ok" } },
          },
        },
      },
    };
    const call = new OpenAPIInvoker({
      parameterConversion: () => "seven",
    }).invokeBinding({
      source: { bindingSpec: BINDING_SPEC_OPENAPI_30, content: spec },
      selector: "#/paths/~1x/post",
      fetch: async (_input, init) => {
        body = init?.body;
        return new Response(null, { status: 204 });
      },
    });
    await call.write({ body: { count: 7 } });
    await call.closed;
    expect(body).toBe("count=seven");
  });
});

function operationDocument(
  method: "get" | "post",
  operation: Record<string, unknown>,
  openapi = "3.1.2",
): Record<string, unknown> {
  return {
    openapi,
    info: { title: "parameter semantics", version: "1" },
    servers: [{ url: "https://api.example.test" }],
    paths: {
      "/x": {
        [method]: {
          ...operation,
          responses: { "204": { description: "ok" } },
        },
      },
    },
  };
}

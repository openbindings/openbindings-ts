import { describe, expect, it } from "vitest";
import jsonata from "jsonata";
import { OperationInvoker, operationSignature } from "@openbindings/sdk";
import { BINDING_SPEC } from "./constants.js";
import { OpenAPIInvoker, OpenAPISynthesizer } from "./invoker.js";

function dynamicBodyDocument(
  openapi: string,
  mediaType: string,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return {
    openapi,
    info: { title: "dynamic object carriage", version: "1" },
    servers: [{ url: "https://api.example.test" }],
    paths: {
      "/items": {
        post: {
          operationId: "createItem",
          parameters: [{
            name: "id",
            in: "query",
            required: true,
            schema: { type: "string" },
          }],
          requestBody: {
            required: true,
            content: { [mediaType]: { schema } },
          },
          responses: { "204": { description: "stored" } },
        },
      },
    },
  };
}

async function joinedInvocation(
  source: Record<string, unknown>,
  input: Record<string, unknown>,
  observe: (request: Request) => Promise<void>,
): Promise<Record<string, unknown>> {
  const iface = await new OpenAPISynthesizer().synthesizeInterface({
    sources: [{ bindingSpec: BINDING_SPEC, content: source }],
  });
  const binding = iface.bindings?.["createItem.openapi"];
  expect(binding?.inputTransform).toBeTypeOf("string");
  const invoker = new OperationInvoker([new OpenAPIInvoker()], {
    fetch: async (request, init) => {
      await observe(new Request(request, init));
      return new Response(undefined, { status: 204 });
    },
    transformEvaluator: {
      evaluate: (expression, data) => jsonata(expression).evaluate(data),
    },
  });
  const call = invoker.invoke(iface, operationSignature("createItem"));
  await call.write(input);
  await call.close();
  for await (const _output of call.outputs) { /* drain */ }
  return iface;
}

describe("openbindings.openapi@1 dynamic object carriage", () => {
  it("keeps an additionalProperties form object independent from a same-named query parameter", async () => {
    const source = dynamicBodyDocument("3.0.4", "application/x-www-form-urlencoded", {
      type: "object",
      properties: { fixed: { type: "string" } },
      additionalProperties: { type: "string" },
    });
    const iface = await joinedInvocation(source, {
      id: "query-value",
      payload: { id: "body-value", extra: "a b", fixed: "yes" },
    }, async (request) => {
      expect(new URL(request.url).searchParams.get("id")).toBe("query-value");
      expect(request.headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
      expect(await request.text()).toBe("extra=a+b&fixed=yes&id=body-value");
    });
    const operation = (iface.operations as Record<string, { input: unknown }>).createItem!;
    expect(operation.input).toEqual({
      type: "object",
      properties: {
        id: { type: "string" },
        payload: {
          type: "object",
          properties: { fixed: { type: "string" } },
          additionalProperties: { type: "string" },
        },
      },
      additionalProperties: false,
      required: ["id", "payload"],
    });
  });

  it("uses an OAS 3.1 patternProperties schema to encode a dynamic multipart member", async () => {
    const source = dynamicBodyDocument("3.1.2", "multipart/form-data", {
      type: "object",
      patternProperties: {
        "^meta_": { type: "object", additionalProperties: { type: "string" } },
      },
      additionalProperties: false,
    });
    await joinedInvocation(source, {
      id: "query-value",
      payload: { meta_first: { role: "admin" } },
    }, async (request) => {
      const form = await request.formData();
      const value = form.get("meta_first");
      expect(value).toBeInstanceOf(File);
      expect((value as File).type).toBe("application/json");
      expect(await (value as File).text()).toBe('{"role":"admin"}');
    });
  });

});

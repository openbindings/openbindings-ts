import { describe, expect, it } from "vitest";
import jsonata from "jsonata";
import { OperationInvoker, operationSignature } from "@openbindings/sdk";
import { BINDING_SPEC } from "./constants.js";
import { OpenAPIInvoker, OpenAPISynthesizer } from "./invoker.js";

function byteDocument(media = "application/octet-stream"): Record<string, unknown> {
  return {
    openapi: "3.0.4",
    info: { title: "schema-omitted bytes", version: "1" },
    servers: [{ url: "https://api.example.test" }],
    paths: {
      "/archive": {
        post: {
          operationId: "storeArchive",
          requestBody: { required: true, content: { [media]: {} } },
          responses: {
            "200": { description: "stored archive", content: { [media]: {} } },
          },
        },
      },
    },
  };
}

describe("openbindings.openapi@1 OAS 3.0 schema-omitted byte carriage", () => {
  it("synthesizes one Base64 application value and preserves request and response octets", async () => {
    const source = byteDocument();
    const iface = await new OpenAPISynthesizer().synthesizeInterface({
      sources: [{ bindingSpec: BINDING_SPEC, content: source }],
    });
    expect(iface.operations.storeArchive?.input).toEqual({
      type: "object",
      properties: { body: { type: "string", contentEncoding: "base64" } },
      additionalProperties: false,
      required: ["body"],
    });
    expect(iface.operations.storeArchive?.output).toEqual({
      type: "string",
      contentEncoding: "base64",
    });

    const invoker = new OperationInvoker([new OpenAPIInvoker()], {
      fetch: async (request, init) => {
        const observed = new Request(request, init);
        expect(observed.headers.get("Content-Type")).toBe("application/octet-stream");
        expect([...new Uint8Array(await observed.arrayBuffer())]).toEqual([0, 1, 254, 255]);
        return new Response(Uint8Array.from([222, 173, 190, 239]), {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      },
      transformEvaluator: { evaluate: (expression, data) => jsonata(expression).evaluate(data) },
    });
    const call = invoker.invoke(iface, operationSignature("storeArchive"));
    await call.write({ body: "AAH+/w==" });
    await call.close();
    const outputs: unknown[] = [];
    for await (const output of call.outputs) outputs.push(output);
    expect(outputs).toEqual(["3q2+7w=="]);
  });

  it("does not turn a schema-omitted media range into one assumed byte representation", async () => {
    const iface = await new OpenAPISynthesizer().synthesizeInterface({
      sources: [{ bindingSpec: BINDING_SPEC, content: byteDocument("application/*") }],
    });
    expect(iface.operations.storeArchive?.input).toEqual({
      type: "object",
      properties: { body: {} },
      additionalProperties: false,
      required: ["body"],
    });
    expect(iface.operations.storeArchive?.output).toBeUndefined();
  });
});

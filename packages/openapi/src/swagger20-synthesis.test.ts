import { describe, expect, it } from "vitest";
import { createJSONExecutor } from "@openbindings/jsonata";
import { createJSONataEvaluator } from "@openbindings/invoke/jsonata";
const officialEvaluator = createJSONataEvaluator(createJSONExecutor());
import { OpenAPISynthesizer } from "./invoker.js";
import { BINDING_SPEC_OPENAPI_20 } from "./constants.js";
import { OpenAPIInvoker } from "./invoker.js";
import { OperationInvoker } from "@openbindings/invoke";
import { equalJSON } from "@openbindings/json";

describe("Swagger 2.0 generated absence branches", () => {
  const cases = [
    { name: "body only", query: false, required: true, input: { body: { id: 0.1 } }, expected: { body: { id: 0.1 } } },
    { name: "parameters only", query: true, required: undefined, input: { id: "7" }, expected: { parameters: { id: "7" } } },
    { name: "optional absent body", query: false, required: false, input: {}, expected: {} },
    { name: "parameters and absent body", query: true, required: false, input: { id: "7" }, expected: { parameters: { id: "7" } } },
    { name: "parameters and body", query: true, required: true, input: { id: "7", body: { id: 0.1 } }, expected: { parameters: { id: "7" }, body: { id: 0.1 } } },
    { name: "missing required body", query: false, required: true, input: {}, expected: {} },
  ];
  for (const fixture of cases) {
    it(fixture.name, async () => {
      const iface = await new OpenAPISynthesizer().synthesizeInterface({ sources: [{
        bindingSpec: BINDING_SPEC_OPENAPI_20,
        content: {
          swagger: "2.0", info: { title: "Absence", version: "1" }, schemes: ["https"], host: "fixture.invalid",
          consumes: ["application/json"], paths: { "/items": { post: {
            operationId: "createItem",
            parameters: [
              ...(fixture.query ? [{ name: "id", in: "query", type: "string", required: true }] : []),
              ...(fixture.required !== undefined ? [{ name: "payload", in: "body", required: fixture.required, schema: { type: "object" } }] : []),
            ], responses: { "204": { description: "ok" } },
          } } },
        },
      }] });
      // Only the serialized artifact crosses from generation to consumption.
      const document = JSON.parse(JSON.stringify(iface));
      const expression = document.bindings["createItem.openapi"].inputTransform;
      expect(equalJSON(await officialEvaluator.evaluate(expression, fixture.input), fixture.expected)).toBe(true);
      let dispatches = 0;
      const call = new OperationInvoker([new OpenAPIInvoker()], {
        transformEvaluator: { evaluate: (expr, value) => officialEvaluator.evaluate(expr, value) },
        fetch: async () => { dispatches++; return new Response(null, { status: 204 }); },
      }).invoke(document, { key: "createItem" });
      const closed = call.closed.then(() => undefined, error => error);
      const read = (async () => { try { for await (const value of call.outputs) void value; } catch { /* closed asserted */ } })();
      try { await call.write(fixture.input); await call.close(); } catch { /* closed asserted */ }
      const error = await closed;
      await read;
      if (fixture.name === "missing required body") {
        expect(error).toMatchObject({ code: "ERR_OPERATION_VALIDATION_FAILED" });
        expect(dispatches).toBe(0);
      } else {
        expect(error).toBeUndefined();
        expect(dispatches).toBe(1);
      }
    });
  }
});

describe("Swagger 2.0 adapter synthesis", () => {
  it("keeps contracts flat and constructs only the invocation envelope", async () => {
    const iface = await new OpenAPISynthesizer().synthesizeInterface({ sources: [{
      bindingSpec: BINDING_SPEC_OPENAPI_20,
      content: {
        swagger: "2.0", schemes: ["https"], host: "api.example", consumes: ["application/json"],
        paths: { "/pets": { post: {
          operationId: "createPet",
          parameters: [
            { name: "id", in: "query", required: true, type: "string" },
            { name: "payload", in: "body", required: true, schema: { type: "object" } },
          ],
          responses: { 204: { description: "ok" } },
        } } },
      },
    }] });
    expect(iface.operations.createPet?.input).toMatchObject({
      type: "object",
      properties: { id: { type: "string" }, body: { type: "object" } },
      required: ["body", "id"],
    });
    const binding = iface.bindings?.["createPet.openapi"];
    expect(binding?.outputTransform).toBeUndefined();
    expect(await officialEvaluator.evaluate(binding?.inputTransform as string, { id: "7", body: { name: "Ada" } })).toEqual({
      parameters: { id: "7" },
      body: { name: "Ada" },
    });
  });
});

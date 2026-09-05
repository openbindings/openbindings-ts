import { describe, expect, it } from "vitest";
import { OperationInvoker, single } from "@openbindings/invoke";
import { OpenAPIAdapter } from "./adapter.js";
import { BINDING_SPEC_OPENAPI_31 } from "./constants.js";

const document = {
  openapi: "3.1.0",
  info: { title: "Adapter proof", version: "1" },
  servers: [{ url: "https://api.example.test" }],
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  },
};

describe("OpenAPIAdapter", () => {
  it("provides one coherent synthesis, inspection, and invocation registration", async () => {
    const fetchFn: typeof fetch = async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const adapter = new OpenAPIAdapter({ fetch: fetchFn });
    const source = { bindingSpec: BINDING_SPEC_OPENAPI_31, content: document };
    const inspection = await adapter.inspectSource(source);
    expect(inspection.exhaustive).toBe(true);
    expect(inspection.targets.map(({ operationKey }) => operationKey)).toEqual(["ping"]);
    const result = await adapter.synthesizeInterfaceWithCoverage({ sources: [source] });
    expect(result.coverage.exhaustive).toBe(true);
    const invoker = new OperationInvoker([adapter], { fetch: fetchFn });
    expect(await single(invoker.invoke(result.interface, { key: "ping" }).outputs)).toEqual({ ok: true });
  });
});

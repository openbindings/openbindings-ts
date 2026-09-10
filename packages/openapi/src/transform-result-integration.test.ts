import { describe, expect, it } from "vitest";
import jsonata from "jsonata";
import { OperationInvoker } from "@openbindings/invoke";
import type { OBInterface } from "@openbindings/core";
import { OpenAPIInvoker } from "./invoker.js";

describe("documented JSONata adapter result boundary", () => {
  for (const direction of ["input", "output"] as const) {
    for (const expression of ["1e308 * 1e308", '{"nested":[1e308 * 1e308]}', "function(){1}"]) {
      it(`${direction}: refuses actual reference result ${expression}`, async () => {
        const iface: OBInterface = {
          openbindings: "0.2.0", operations: { test: {} },
          sources: { api: { bindingSpec: "openbindings.openapi-3.1@1", content: {
            openapi: "3.1.2", info: { title: "Result domain", version: "1" },
            servers: [{ url: "https://fixture.invalid" }], paths: { "/test": { post: {
              operationId: "test", responses: { "200": { description: "ok", content: { "application/json": { schema: {} } } } },
            } } },
          } } },
          bindings: { test: { source: "api", operation: "test", selector: "#/paths/~1test/post", [direction + "Transform"]: expression } },
        };
        let dispatches = 0;
        const call = new OperationInvoker([new OpenAPIInvoker()], {
          transformEvaluator: { evaluate: (expr, value) => jsonata(expr).evaluate(value) },
          fetch: async () => { dispatches++; return new Response("1", { headers: { "content-type": "application/json" } }); },
        }).invoke(iface, { key: "test" });
        const values: unknown[] = [];
        const reading = (async () => { try { for await (const value of call.outputs) values.push(value); } catch { /* closed below */ } })();
        const closed = call.closed.then(() => null, error => error);
        try { await call.write({}); await call.close(); } catch { /* closed below */ }
        expect(await closed).toMatchObject({ code: "ERR_TRANSFORM_ERROR" });
        await reading;
        expect(values).toEqual([]);
        expect(dispatches).toBe(direction === "input" ? 0 : 1);
      });
    }
  }
});

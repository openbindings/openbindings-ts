import { describe, expect, it } from "vitest";
import { compileOperationSchema } from "@openbindings/core";
import { OpenAPISynthesizer } from "./synthesizer.js";
import { BINDING_SPEC_OPENAPI_20 } from "./constants.js";

describe("Swagger schema placement", () => {
  for (const external of [false, true]) for (const alternatives of [false, true]) {
    it(`preserves independent recursive closures (external=${external}, alternatives=${alternatives})`, async () => {
      const definitions = Object.fromEntries([['Node', 'integer'], ['Word', 'string']].map(([name, type]) => [name, {
        type: "object", required: ["value"], properties: {
          value: { type }, next: { $ref: `#/definitions/${name}` },
          literal: { type: "object", default: { $ref: "#/$defs/schema0" } },
        },
      }]));
      const ref = (name: string) => ({ $ref: `${external ? "schema.json" : ""}#/definitions/${name}` });
      let reads = 0;
      const synth = new OpenAPISynthesizer({ fetch: async (request) => {
        reads++;
        expect(String(request)).toBe("https://artifact.example/schema.json");
        return Response.json({ definitions });
      } });
      const iface = await synth.synthesizeInterface({ sources: [{
        bindingSpec: BINDING_SPEC_OPENAPI_20,
        location: "https://artifact.example/openapi.json",
        content: {
          swagger: "2.0", info: { title: "Placement", version: "1" }, host: "api.example", schemes: ["https"],
          consumes: ["application/json"], produces: ["application/json"], definitions,
          paths: { "/echo": { post: {
            operationId: "echo", parameters: [
              { name: "body", in: "query", type: "boolean" },
              { name: "payload", in: "body", required: true, schema: ref("Node") },
            ], responses: {
              "200": { description: "ok", schema: ref("Node") },
              ...(alternatives ? { "201": { description: "word", schema: ref("Word") } } : {}),
            },
          } } },
        },
      }] });
      expect(reads > 0).toBe(external);
      const input = compileOperationSchema(iface, "echo", "input");
      const output = compileOperationSchema(iface, "echo", "output");
      const good = { value: 7, next: { value: 8 } };
      expect(input.validate({ body: true, body_2: good }).valid).toBe(true);
      expect(input.validate({ body_2: { value: "wrong" } }).valid).toBe(false);
      expect(output.validate(good).valid).toBe(true);
      expect(output.validate({ value: "word", next: { value: "nested" } }).valid).toBe(alternatives);
      expect(output.validate({ value: true }).valid).toBe(false);
      expect(JSON.stringify(iface.operations.echo)).toContain('"default":{"$ref":"#/$defs/schema0"}');
    });
  }
});

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import jsonata from "jsonata";
import { compileOperationSchema } from "@openbindings/core";
import { OperationInvoker, operationSignature, single } from "@openbindings/invoke";
import { OpenAPIInvoker, OpenAPISynthesizer } from "./test-helpers.js";
import { BINDING_SPEC_OPENAPI_31 as BINDING_SPEC } from "./constants.js";

// A recursive component: Tree.children -> Tree. After full dereference this
// is a true object cycle; synthesis must emit an equivalent acyclic schema
// using $defs/$ref (JSON Schema 2020-12's own recursion mechanism), never
// crash and never emit a dangling reference.
const RECURSIVE_DOC = {
  openapi: "3.1.0",
  info: { title: "recursive", version: "1.0.0" },
  servers: [{ url: "https://api.example.test" }],
  paths: {
    "/trees": {
      post: {
        operationId: "createTree",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/Tree" } } },
        },
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Tree" } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Tree: {
        type: "object",
        properties: {
          label: { type: "string" },
          children: { type: "array", items: { $ref: "#/components/schemas/Tree" } },
        },
      },
    },
  },
};

describe("cyclic schema synthesis (rev 2a)", () => {
  it("synthesizes a recursive component as $defs/$ref, JSON-serializable", async () => {
    const synth = new OpenAPISynthesizer();
    const result = await synth.synthesizeInterfaceWithCoverage({
      sources: [{ bindingSpec: BINDING_SPEC, content: structuredClone(RECURSIVE_DOC) }],
    });
    const op = result.interface.operations["createTree"];
    expect(op).toBeDefined();
    if (!op) throw new Error("createTree operation was not synthesized");

    // The whole interface must serialize — the OBI is a JSON document.
    const serialized = JSON.stringify(result.interface);
    expect(serialized).toContain('"#/operations/createTree/input/$defs/Tree"');

    // The flattened input carries Tree's properties; the recursive member
    // references the hoisted definition.
    const input = op.input as Record<string, any>;
    expect(input.$defs?.Tree).toBeDefined();
    expect(JSON.stringify(input.$defs.Tree)).toContain('"#/operations/createTree/input/$defs/Tree"');

    const output = op.output as Record<string, any>;
    expect(JSON.stringify(output)).toContain('"#/operations/createTree/output/$defs/Tree"');
    expect(result.coverage.fullyRepresented).toBe(true);
  });

  it("invokes a synthesized recursive operation through the Core document-root schema boundary", async () => {
    const iface = await new OpenAPISynthesizer().synthesizeInterface({
      sources: [{ bindingSpec: BINDING_SPEC, content: structuredClone(RECURSIVE_DOC) }],
    });
    const tree = {
      label: "root",
      children: [{ label: "leaf", children: [] }],
    };
    expect(() =>
      compileOperationSchema(structuredClone(iface), "createTree", "input"),
    ).not.toThrow();
    const fetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify(tree), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const invoker = new OperationInvoker([new OpenAPIInvoker()], {
      fetch,
      transformEvaluator: {
        evaluate: (expression, data) => jsonata(expression).evaluate(data),
      },
    });
    const call = invoker.invoke(iface, operationSignature("createTree"));
    await call.write(tree);
    await call.close();
    await expect(single(call.outputs)).resolves.toEqual(tree);
  });

  it("recovers a real-world cyclic artifact (corpus regression)", { timeout: 30000 }, async () => {
    const path = "/tmp/corpus/node_modules/openapi-directory/api/amazonaws.com/elasticmapreduce.json";
    if (!existsSync(path)) return; // corpus not present in this environment
    const content = JSON.parse(readFileSync(path, "utf8"));
    const synth = new OpenAPISynthesizer();
    const result = await synth.synthesizeInterfaceWithCoverage({
      sources: [{ bindingSpec: BINDING_SPEC, content }],
    });
    expect(Object.keys(result.interface.operations).length).toBeGreaterThan(0);
    expect(() => JSON.stringify(result.interface)).not.toThrow();
  });
});

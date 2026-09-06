import { describe, expect, it } from "vitest";
import type { OBInterface } from "./types.js";
import { prepareInterface } from "./prepared-interface.js";

function document(): OBInterface {
  return {
    openbindings: "0.2.0",
    schemas: {
      Item: {
        type: "object",
        properties: { id: { type: "string", pattern: "^[a-z]+$" } },
        required: ["id"],
      },
      Unused: { type: "number" },
    },
    operations: {
      deliver: {
        aliases: ["send"],
        input: { $ref: "#/schemas/Item" },
        output: true,
      },
    },
    dependencies: {
      delivery: {
        operation: "deliver",
        bindingSpecs: ["https://example.com/handler"],
      },
    },
    sources: {
      local: {
        bindingSpec: "https://example.com/handler",
        content: { handler: "delivery" },
      },
    },
    bindings: {
      local: { operation: "deliver", source: "local" },
    },
  };
}

describe("PreparedInterface", () => {
  it("is content-addressed, immutable, and idempotent", async () => {
    const original = document();
    const first = await prepareInterface(original);
    const reordered = {
      operations: original.operations,
      openbindings: original.openbindings,
      bindings: original.bindings,
      sources: original.sources,
      dependencies: original.dependencies,
      schemas: original.schemas,
    };
    const second = await prepareInterface(reordered);

    expect(first.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.revision).toBe(first.revision);
    expect(await prepareInterface(first)).toBe(first);

    original.operations.deliver!.description = "mutated";
    expect(first.operation("deliver")?.operation.description).toBeUndefined();
    expect(Object.isFrozen(first.interfaceSnapshot.operations.deliver)).toBe(true);
  });

  it("builds exact operation, dependency, binding, and schema indexes", async () => {
    const prepared = await prepareInterface(document());
    const operation = prepared.operation("send");
    const dependency = prepared.dependency("delivery");
    const binding = prepared.binding("local");

    expect(operation?.canonicalKey).toBe("deliver");
    expect(operation?.bindingKeys).toEqual(["local"]);
    expect(operation?.dependencyKeys).toEqual(["delivery"]);
    expect(dependency?.operation).toBe(operation);
    expect(dependency?.allowedBindingSpecs).toEqual(["https://example.com/handler"]);
    expect(dependency?.allowsBindingSpec("https://example.com/handler")).toBe(true);
    expect(binding?.operation).toBe(operation);
    expect(binding?.bindingSpec).toBe("https://example.com/handler");

    const firstValidator = prepared.schemaValidator("deliver", "input");
    expect(prepared.schemaValidator("send", "input")).toBe(firstValidator);
    expect(firstValidator?.validate({ id: "valid" }).valid).toBe(true);
    expect(firstValidator?.validate({ id: "INVALID" }).valid).toBe(false);
  });

  it("keeps RFC 8785 order for array-index-like Core names", async () => {
    const prepared = await prepareInterface({
      openbindings: "0.2.0",
      operations: {
        "2": {},
        "10": {},
      },
    });

    expect(prepared.operationKeys()).toEqual(["10", "2"]);
    expect(prepared.canonical).toBe(
      '{"openbindings":"0.2.0","operations":{"10":{},"2":{}}}',
    );
  });

  it("identifies the exact reachable authored boundary graph", async () => {
    const base = await prepareInterface(document());
    const baseContract = await base.boundaryContract("deliver")!;
    expect(baseContract.complete).toBe(true);

    const irrelevant = document();
    irrelevant.schemas!.Unused = { type: "integer" };
    const irrelevantContract = await (await prepareInterface(irrelevant))
      .boundaryContract("deliver")!;
    expect(irrelevantContract.revision).toBe(baseContract.revision);

    const relevant = document();
    relevant.schemas!.Item = {
      type: "object",
      properties: { id: { type: "string", pattern: "^[A-Z]+$" } },
      required: ["id"],
    };
    const relevantContract = await (await prepareInterface(relevant))
      .boundaryContract("deliver")!;
    expect(relevantContract.revision).not.toBe(baseContract.revision);

    const reorderedAllOf = document();
    reorderedAllOf.operations.deliver!.input = {
      allOf: [{ type: "string" }, { minLength: 1 }],
    };
    const firstOrder = await (await prepareInterface(reorderedAllOf))
      .boundaryContract("deliver")!;
    reorderedAllOf.operations.deliver!.input = {
      allOf: [{ minLength: 1 }, { type: "string" }],
    };
    const secondOrder = await (await prepareInterface(reorderedAllOf))
      .boundaryContract("deliver")!;
    expect(secondOrder.revision).not.toBe(firstOrder.revision);
  });

  it("reports external schema closure instead of fetching ambiently", async () => {
    const iface = document();
    iface.operations.deliver!.input = { $ref: "https://schemas.example/Item" };
    const contract = await (await prepareInterface(iface)).boundaryContract("deliver")!;
    expect(contract.complete).toBe(false);
    expect(contract.unavailableReferences).toEqual(["https://schemas.example/Item"]);
  });

  it("closes cyclic internal schema graphs without recursive expansion", async () => {
    const iface = document();
    iface.schemas = {
      Node: {
        type: "object",
        properties: {
          value: { type: "string" },
          next: { $ref: "#/schemas/Node" },
        },
      },
    };
    iface.operations.deliver!.input = { $ref: "#/schemas/Node" };

    const first = await (await prepareInterface(iface)).boundaryContract("deliver")!;
    const second = await (await prepareInterface(structuredClone(iface)))
      .boundaryContract("deliver")!;

    expect(first.complete).toBe(true);
    expect(first.revision).toBe(second.revision);
    expect(first.canonical).toBe(second.canonical);
  });
});

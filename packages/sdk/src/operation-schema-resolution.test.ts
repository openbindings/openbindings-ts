import { describe, expect, it } from "vitest";
import { compileOperationSchema, safeValidate } from "./schema-validation.js";
import type { JSONSchema, OBInterface } from "./types.js";

interface ResolutionCase {
  name: string;
  operation: string;
  schema: JSONSchema;
  schemas?: Record<string, JSONSchema>;
  extraOperations?: OBInterface["operations"];
  valid: unknown;
  invalid: unknown;
}

describe("operation schema document-root resolution matrix", () => {
  const cases: ResolutionCase[] = [
    {
      name: "named schema",
      operation: "target",
      schema: { $ref: "#/schemas/Identifier" },
      schemas: { Identifier: { type: "string" } },
      valid: "ok",
      invalid: 1,
    },
    {
      name: "operation-local recursive definition",
      operation: "target",
      schema: {
        $ref: "#/operations/target/output/$defs/Node",
        $defs: {
          Node: {
            type: "object",
            properties: {
              value: { type: "string" },
              next: { $ref: "#/operations/target/output/$defs/Node" },
            },
            required: ["value"],
          },
        },
      },
      valid: { value: "a", next: { value: "b" } },
      invalid: { value: "a", next: { value: 2 } },
    },
    {
      name: "cross-operation schema",
      operation: "target",
      schema: { $ref: "#/operations/shared/output" },
      extraOperations: { shared: { output: { type: "integer" } } },
      valid: 2,
      invalid: "2",
    },
    {
      name: "escaped operation key",
      operation: "a/b~c",
      schema: {
        $ref: "#/operations/a~1b~0c/output/$defs/Value",
        $defs: { Value: { type: "boolean" } },
      },
      valid: true,
      invalid: "true",
    },
    {
      name: "absolute ref to embedded id resource",
      operation: "target",
      schema: { $ref: "https://schemas.example.test/Identifier" },
      schemas: {
        EarlierResource: {
          $id: "https://schemas.example.test/EarlierResource",
          type: "integer",
        },
        Identifier: {
          $id: "https://schemas.example.test/Identifier",
          type: "string",
          format: "email",
        },
      },
      valid: "not-an-email",
      invalid: false,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const iface: OBInterface = {
        openbindings: "0.2.0",
        schemas: testCase.schemas,
        operations: {
          ...(testCase.extraOperations ?? {}),
          [testCase.operation]: { output: testCase.schema },
        },
      };
      const validator = compileOperationSchema(iface, testCase.operation, "output");
      expect(safeValidate(validator, testCase.valid).valid).toBe(true);
      expect(safeValidate(validator, testCase.invalid).valid).toBe(false);
    });
  }

  it("does not interpret unknown OBI-root fields as JSON Schema keywords", () => {
    const iface = {
      openbindings: "0.2.0",
      type: "integer",
      operations: { target: { output: { type: "string" } } },
    } as OBInterface;
    const validator = compileOperationSchema(iface, "target", "output");
    expect(safeValidate(validator, "ok").valid).toBe(true);
    expect(safeValidate(validator, 1).valid).toBe(false);
  });

  it("keeps non-keyword extension locations pointer-addressable", () => {
    const iface = {
      openbindings: "0.2.0",
      "x-contracts": { Value: { type: "string" } },
      operations: { target: { output: { $ref: "#/x-contracts/Value" } } },
    } as OBInterface;
    const validator = compileOperationSchema(iface, "target", "output");
    expect(safeValidate(validator, "ok").valid).toBe(true);
    expect(safeValidate(validator, 1).valid).toBe(false);
  });
});

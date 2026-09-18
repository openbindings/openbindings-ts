import { describe, expect, it } from "vitest";
import { parseJSON } from "@openbindings/json";
import { compileOperationSchema } from "./schema-validation.js";
import type { OBInterface } from "./types.js";

describe("reused backend-proved reachable schema admission", () => {
  it("keeps independent exact contracts and checks referenced targets", () => {
    const doc: OBInterface = { openbindings: "0.2.0", operations: {}, schemas: {
      wide: { type: "integer", minimum: parse("9007199254740993") },
    } };
    for (let i = 0; i < 100; i++) doc.operations["op" + i] = { input: { $ref: "#/schemas/wide" } };
    for (let i = 0; i < 100; i++) {
      const validator = compileOperationSchema(doc, "op" + i, "input");
      expect(validator.validate(parse("9007199254740993")).valid).toBe(true);
      expect(validator.validate(parse("9007199254740992")).valid).toBe(false);
    }
    const invalid: OBInterface = { openbindings: "0.2.0", operations: { x: { input: { $ref: "#/x-schema" } } },
      "x-schema": { minItems: parse("0.0000000000000000001") } };
    expect(() => compileOperationSchema(invalid, "x", "input")).toThrow(/schema/);
    const missing: OBInterface = { openbindings: "0.2.0", operations: { x: { input: { anyOf: [true, { $ref: "#/missing" }] } } } };
    expect(() => compileOperationSchema(missing, "x", "input")).toThrow();
  });
});

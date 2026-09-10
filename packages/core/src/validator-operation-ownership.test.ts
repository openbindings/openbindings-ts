import { describe, expect, it } from "vitest";
import { prepareInterface } from "./prepared-interface.js";

describe("operation-owned validators independent of identity call order", () => {
  for (const identityFirst of [false, true]) it(String(identityFirst), async () => {
    const input = { type: "integer", minimum: 1 };
    const prepared = await prepareInterface({ openbindings: "0.2.0", operations: { a: { input }, b: { input } } });
    if (identityFirst) {
      await prepared.boundaryContract("a"); await prepared.boundaryContract("b");
    }
    const a = prepared.schemaValidator("a", "input")!, b = prepared.schemaValidator("b", "input")!;
    expect(a).not.toBe(b);
    await prepared.boundaryContract("a"); await prepared.boundaryContract("b");
    expect(prepared.schemaValidator("a", "input")).toBe(a);
    expect(prepared.schemaValidator("b", "input")).toBe(b);
    expect(a.validate(0).failures[0]!.schemaPath).toBe("/operations/a/input/minimum");
    expect(b.validate(0).failures[0]!.schemaPath).toBe("/operations/b/input/minimum");
  });
});

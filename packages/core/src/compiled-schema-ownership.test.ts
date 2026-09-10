import { expect, it } from "vitest";
import { prepareInterface } from "./prepared-interface.js";

it("does not expose mutation of a retained validator through a prepared snapshot", async () => {
  const prepared = await prepareInterface({openbindings: "0.2.0", operations: {test: {input: {type: "string"}}}});
  const validator = prepared.schemaValidator("test", "input")!;
  expect(Reflect.set(validator, "validate", () => ({valid: true, failures: []}))).toBe(false);
  expect(prepared.schemaValidator("test", "input")).toBe(validator);
  expect(validator.validate(1).valid).toBe(false);
});

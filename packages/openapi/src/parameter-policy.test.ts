import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decimalParameterConversion } from "./parameter-policy.js";

it("matches the shared Go/TypeScript consumer-policy vectors", () => {
  const cases = JSON.parse(readFileSync(new URL("../testdata/parameter-policy.json", import.meta.url), "utf8"));
  for (const test of cases) {
    if (test.refuse) expect(() => decimalParameterConversion(test.value)).toThrow();
    else expect(decimalParameterConversion(test.value)).toBe(test.expected);
  }
  for (const value of [NaN, Infinity, -Infinity, 1n]) expect(() => decimalParameterConversion(value)).toThrow();
  expect(decimalParameterConversion(-0)).toBe("0");
});

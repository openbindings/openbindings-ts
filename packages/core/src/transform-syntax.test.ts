import { describe, expect, it, vi } from "vitest";
import { validateInterface } from "./validate.js";
import type { OBInterface } from "./types.js";

// A production validator must not instantiate an evaluator merely to parse.
vi.mock("jsonata", () => { throw Error("Syntax validation loaded an evaluator"); });

describe("parse-only JSONata document validation", () => {
  const validate = (expression: string) => {
    const iface: OBInterface = { openbindings: "0.2.0", operations: {}, transforms: { test: expression } };
    validateInterface(iface);
  };
  for (const expression of ["$", "$unknown()", "$flatten([])", "$error('runtime')", "1/0", "1e9999999999999999999999999", "**", "a.**", "$power(2,8)", "($r := (/a/); $r('a'))", "$ ~> |$|{'ok':true}|", "0 ?? 1", "null ?? 1", "0 ?: 1"]) {
    it(`accepts syntax without evaluation: ${expression}`, () => { expect(() => validate(expression)).not.toThrow(); });
  }
  for (const expression of ["", "2 ** 8", "$ | $ | {'ok':true} |", "1 | 2", "1e+", "01", "1 +", "/a/gg", "/[a/", "function($x){"]) {
    it(`rejects malformed or extra syntax: ${expression}`, () => { expect(() => validate(expression)).toThrow("OBI-D-18"); });
  }
});

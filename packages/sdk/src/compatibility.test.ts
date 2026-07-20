import { describe, it, expect } from "vitest";
import { checkInterfaceCompatibility } from "./compatibility.js";
import type { OBInterface } from "./types.js";

function makeInterface(ops: OBInterface["operations"]): OBInterface {
  return { openbindings: "0.1.0", operations: ops };
}

describe("checkInterfaceCompatibility", () => {
  describe("unspecified output schema", () => {
    it("required has output, provided omits output -> compatible (slot skipped)", async () => {
      const required = makeInterface({
        op: { output: { type: "object" } },
      });
      const provided = makeInterface({
        op: {},
      });
      const issues = await checkInterfaceCompatibility(required, provided);
      expect(issues).toEqual([]);
    });

    it("required omits output, provided has output -> compatible (slot skipped)", async () => {
      const required = makeInterface({
        op: {},
      });
      const provided = makeInterface({
        op: { output: { type: "object" } },
      });
      const issues = await checkInterfaceCompatibility(required, provided);
      expect(issues).toEqual([]);
    });

    it("both have output -> checks compatibility normally", async () => {
      const required = makeInterface({
        op: { output: { type: ["string"] } },
      });
      const provided = makeInterface({
        op: { output: { type: ["string"] } },
      });
      const issues = await checkInterfaceCompatibility(required, provided);
      expect(issues).toEqual([]);
    });

    it("both have output with incompatible types -> reports issue", async () => {
      const required = makeInterface({
        op: { output: { type: ["string"] } },
      });
      const provided = makeInterface({
        op: { output: { type: ["number"] } },
      });
      const issues = await checkInterfaceCompatibility(required, provided);
      expect(issues).toHaveLength(1);
      expect(issues[0].kind).toBe("output_incompatible");
    });
  });

  describe("unspecified input schema", () => {
    it("required has input, provided omits input -> compatible (slot skipped)", async () => {
      const required = makeInterface({
        op: { input: { type: "object" } },
      });
      const provided = makeInterface({
        op: {},
      });
      const issues = await checkInterfaceCompatibility(required, provided);
      expect(issues).toEqual([]);
    });

    it("required omits input, provided has input -> compatible (slot skipped)", async () => {
      const required = makeInterface({
        op: {},
      });
      const provided = makeInterface({
        op: { input: { type: "object" } },
      });
      const issues = await checkInterfaceCompatibility(required, provided);
      expect(issues).toEqual([]);
    });

    it("both have input -> checks compatibility normally", async () => {
      const required = makeInterface({
        op: { input: { type: ["string"] } },
      });
      const provided = makeInterface({
        op: { input: { type: ["string"] } },
      });
      const issues = await checkInterfaceCompatibility(required, provided);
      expect(issues).toEqual([]);
    });

    it("both have input with incompatible types -> reports issue", async () => {
      const required = makeInterface({
        op: { input: { type: ["boolean"] } },
      });
      const provided = makeInterface({
        op: { input: { type: ["string"] } },
      });
      const issues = await checkInterfaceCompatibility(required, provided);
      expect(issues).toHaveLength(1);
      expect(issues[0].kind).toBe("input_incompatible");
    });
  });

  describe("issue ordering", () => {
    it("orders issues by sorted operation key, output before input within an operation", async () => {
      // Pins the issue-ordering contract, mirrored byte-for-byte in the Go
      // SDK's TestCheckInterfaceCompatibility_IssueOrderSortedByOperationKey:
      // issues appear in sorted operation-key order (never declaration or
      // map order), with the output issue before the input issue within an
      // operation. The fixture's keys are deliberately declared out of
      // sorted order.
      const required = makeInterface({
        zulu: { input: { type: ["string"] }, output: { type: ["string"] } },
        alpha: {},
        mike: { input: { type: ["string"] }, output: { type: ["string"] } },
      });
      const provided = makeInterface({
        zulu: { input: { type: ["number"] }, output: { type: ["number"] } },
        mike: { input: { type: ["number"] }, output: { type: ["number"] } },
      });
      const issues = await checkInterfaceCompatibility(required, provided);
      expect(issues.map((i) => [i.operation, i.kind])).toEqual([
        ["alpha", "missing"],
        ["mike", "output_incompatible"],
        ["mike", "input_incompatible"],
        ["zulu", "output_incompatible"],
        ["zulu", "input_incompatible"],
      ]);
    });
  });
});

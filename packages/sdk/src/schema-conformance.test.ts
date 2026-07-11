import { describe, expect, it } from "vitest";
import { compileExampleSchema, safeValidate } from "./schema-validation.js";

/**
 * Pins the boundary-validation semantics the backend swap was ruled to
 * guarantee (the ten divergence axes of the 2026-07-10 parity audit).
 * These tests are backend-agnostic on purpose: any future backend must
 * pass them unchanged.
 */
describe("boundary validation conformance", () => {
  it("required/properties use own properties, never the prototype chain", () => {
    const req = compileExampleSchema({ required: ["toString"] }, undefined);
    expect(req.validate({}).valid).toBe(false);
    const props = compileExampleSchema(
      { properties: { toString: { type: "string" } } },
      undefined,
    );
    expect(props.validate({}).valid).toBe(true);
  });

  it("refuses malformed schemas at compile (draft-4 forms are never misread)", () => {
    expect(() =>
      compileExampleSchema({ minimum: 0, exclusiveMinimum: true }, undefined),
    ).toThrow("does not conform to JSON Schema 2020-12");
    expect(() =>
      compileExampleSchema({ items: [{ type: "string" }] }, undefined),
    ).toThrow("does not conform to JSON Schema 2020-12");
  });

  it("format is an annotation, never an assertion (§6.2)", () => {
    const v = compileExampleSchema({ type: "string", format: "email" }, undefined);
    expect(v.validate("not-an-email").valid).toBe(true);
  });

  it("fully-resolved is judged statically: an unused unresolvable branch still refuses", () => {
    expect(() =>
      compileExampleSchema(
        { anyOf: [{ type: "string" }, { $ref: "https://example.com/never-fetched.json" }] },
        undefined,
      ),
    ).toThrow("unresolvable $ref");
  });

  it("a dangling same-document pointer refuses at compile", () => {
    expect(() =>
      compileExampleSchema({ $ref: "#/$defs/missing" }, undefined),
    ).toThrow("unresolvable $ref");
  });

  it("an absolute $ref matching an embedded $id resolves locally (§10: not external)", () => {
    const v = compileExampleSchema(
      {
        $ref: "https://example.com/task.schema.json",
        $defs: {
          Task: {
            $id: "https://example.com/task.schema.json",
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
          },
        },
      },
      undefined,
    );
    expect(v.validate({ id: "x" }).valid).toBe(true);
    expect(v.validate({}).valid).toBe(false);
  });

  it("anchors resolve within their $id resource; unknown anchors refuse", () => {
    const withAnchor = {
      $ref: "#/$defs/Task",
      $defs: {
        Task: {
          $id: "https://example.com/t.json",
          type: "object",
          properties: { kind: { $ref: "#kindAnchor" } },
          $defs: { kind: { $anchor: "kindAnchor", type: "string" } },
        },
      },
    };
    expect(() => compileExampleSchema(withAnchor, undefined)).not.toThrow();
    const badAnchor = structuredClone(withAnchor);
    (badAnchor.$defs.Task.properties.kind as { $ref: string }).$ref = "#nope";
    expect(() => compileExampleSchema(badAnchor, undefined)).toThrow("unresolvable $ref");
  });

  it("reports ALL failures with Go's pointer dialect", () => {
    const v = compileExampleSchema(
      { properties: { a: { type: "number" }, b: { type: "number" } } },
      undefined,
    );
    const r = safeValidate(v, { a: "x", b: "y" });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.failures.length).toBeGreaterThanOrEqual(2);
      const paths = r.failures.map((f) => f.path).sort();
      expect(paths).toEqual(["/a", "/b"]);
    }
  });

  it("the obsolete draft-7 'dependencies' keyword never asserts (unknown keyword at 2020-12)", () => {
    const v = compileExampleSchema({ dependencies: { a: ["b"] } }, undefined);
    expect(v.validate({ a: 1 }).valid).toBe(true);
    // its 2020-12 replacement still asserts:
    const v2 = compileExampleSchema({ dependentRequired: { a: ["b"] } }, undefined);
    expect(v2.validate({ a: 1 }).valid).toBe(false);
  });
});

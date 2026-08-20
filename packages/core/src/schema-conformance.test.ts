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

  // RFC 6901 §6 / §10: the fragment is percent-decoded first, then
  // evaluated as a JSON Pointer — #/schemas/T%61sk addresses the schemas
  // key Task end to end (compile-time resolvability AND the underlying
  // json-schema-library compile backend), exactly as #/schemas/Task does.
  // json-schema-library (via @sagold/json-pointer) already decodes
  // per-token when the pointer string carries a literal '#', so no
  // additional normalization is needed where refs are handed to it — only
  // the SDK's own static-resolvability walk (resolveFragment) needed the
  // decode-first fix.
  it("a percent-encoded same-document fragment resolves before RFC 6901 evaluation", () => {
    const v = compileExampleSchema(
      { $ref: "#/schemas/T%61sk" },
      { Task: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
    );
    expect(v.validate({ id: "x" }).valid).toBe(true);
    expect(v.validate({}).valid).toBe(false);
  });

  it("a dangling percent-encoded same-document fragment still refuses at compile", () => {
    // Decoding does not weaken fail-closed resolvability: a percent-encoded
    // fragment that decodes to a genuinely-missing location still refuses.
    expect(() =>
      compileExampleSchema({ $ref: "#/schemas/M%69ssing" }, { Task: { type: "object" } }),
    ).toThrow("unresolvable $ref");
  });

  // T-07/T-08's "whole governing schema" is the static closure REACHABLE
  // from the governing root (keyword subschemas + reference targets,
  // transitively). A lexically-present but unreachable entry never
  // participates in a verdict and must not poison the boundary — mirrors
  // the Go SDK's compiler, which resolves lazily from the root.
  it("an unreferenced $defs entry with an external $ref does not poison the boundary", () => {
    const v = compileExampleSchema(
      { type: "string", $defs: { dead: { $ref: "https://example.com/never-fetched.json" } } },
      undefined,
    );
    expect(v.validate("hi").valid).toBe(true);
  });

  it("an unrelated document-schemas entry with an external $ref does not poison other operations", () => {
    const v = compileExampleSchema(
      { type: "string" },
      { Unused: { $ref: "https://example.com/never-fetched.json" } },
    );
    expect(v.validate("hi").valid).toBe(true);
  });

  it("an external $ref reached only through a $defs reference still refuses", () => {
    expect(() =>
      compileExampleSchema(
        { $ref: "#/$defs/a", $defs: { a: { $ref: "https://example.com/never-fetched.json" } } },
        undefined,
      ),
    ).toThrow("unresolvable $ref");
  });

  it("a document-schemas entry reached from the governing root still refuses on its external $ref", () => {
    expect(() =>
      compileExampleSchema(
        { $ref: "#/$defs/Used" },
        { Used: { $ref: "https://example.com/never-fetched.json" } },
      ),
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
    (badAnchor.$defs.Task.properties.kind).$ref = "#nope";
    expect(() => compileExampleSchema(badAnchor, undefined)).toThrow("unresolvable $ref");
  });

  // OBI-D-05's carve-out: a $dynamicRef/$dynamicAnchor pair confined inside
  // a schema declaring its own $id is that resource's internal business
  // (full 2020-12 recursive-extension semantics apply within it). The
  // invocation-boundary compiler (assertFullyResolvable) must not treat
  // $dynamicRef as a resolvable-reference it needs to chase — it does not
  // participate in same-document reference resolution (mirrors OBI-D-16's
  // note and the Go SDK's TestValidateAgainstSchema_DynamicPairInsideEmbeddedID).
  it("does not choke on a legal $dynamicRef/$dynamicAnchor pair inside an embedded $id resource", () => {
    const defs = {
      Tree: {
        $id: "https://example.com/tree.schema.json",
        $dynamicAnchor: "node",
        type: "object",
        properties: {
          children: { type: "array", items: { $dynamicRef: "#node" } },
        },
      },
    };
    const v = compileExampleSchema({ $ref: "#/$defs/Tree" }, defs);
    expect(v.validate({ children: [{ children: [] }] }).valid).toBe(true);
    expect(v.validate({ children: [{ children: "nope" }] }).valid).toBe(false);
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

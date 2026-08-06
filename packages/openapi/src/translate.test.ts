import { describe, it, expect } from "vitest";
import { translateSchemaDialect } from "./translate.js";

describe("translateSchemaDialect — OpenAPI 3.0 → JSON Schema 2020-12", () => {
  describe("nullable", () => {
    it("translates {type: T, nullable: true} to {type: [T, 'null']}", () => {
      const out = translateSchemaDialect({ type: "string", nullable: true }, "3.0");
      expect(out).toEqual({ type: ["string", "null"] });
    });

    it("appends 'null' to an existing type array", () => {
      const out = translateSchemaDialect(
        { type: ["string", "number"], nullable: true },
        "3.0",
      );
      expect(out).toEqual({ type: ["string", "number", "null"] });
    });

    it("does not duplicate 'null' if already present", () => {
      const out = translateSchemaDialect(
        { type: ["string", "null"], nullable: true },
        "3.0",
      );
      expect(out).toEqual({ type: ["string", "null"] });
    });

    it("drops nullable when no type is present", () => {
      const out = translateSchemaDialect({ nullable: true, description: "x" }, "3.0");
      expect(out).toEqual({ description: "x" });
    });

    it("drops nullable: false", () => {
      const out = translateSchemaDialect({ type: "string", nullable: false }, "3.0");
      expect(out).toEqual({ type: "string" });
    });

    it("recurses into properties", () => {
      const out = translateSchemaDialect(
        {
          type: "object",
          properties: {
            next: { type: "string", nullable: true },
            count: { type: "integer" },
          },
        },
        "3.0",
      );
      expect(out).toEqual({
        type: "object",
        properties: {
          next: { type: ["string", "null"] },
          count: { type: "integer" },
        },
      });
    });

    it("recurses into items", () => {
      const out = translateSchemaDialect(
        { type: "array", items: { type: "string", nullable: true } },
        "3.0",
      );
      expect(out).toEqual({
        type: "array",
        items: { type: ["string", "null"] },
      });
    });

    it("recurses into oneOf/anyOf/allOf", () => {
      const out = translateSchemaDialect(
        {
          oneOf: [
            { type: "string", nullable: true },
            { type: "integer" },
          ],
        },
        "3.0",
      );
      expect(out).toEqual({
        oneOf: [{ type: ["string", "null"] }, { type: "integer" }],
      });
    });

    it("recurses into additionalProperties when an object", () => {
      const out = translateSchemaDialect(
        { type: "object", additionalProperties: { type: "string", nullable: true } },
        "3.0",
      );
      expect(out).toEqual({
        type: "object",
        additionalProperties: { type: ["string", "null"] },
      });
    });

    it("preserves additionalProperties: true", () => {
      const out = translateSchemaDialect(
        { type: "object", additionalProperties: true },
        "3.0",
      );
      expect(out).toEqual({ type: "object", additionalProperties: true });
    });

    it("does not recurse into example/examples/enum/default values", () => {
      const out = translateSchemaDialect(
        {
          type: "string",
          example: { type: "string", nullable: true },
          enum: ["a", "b"],
          default: "a",
        },
        "3.0",
      );
      // example/enum/default copied through, NOT translated.
      expect(out).toEqual({
        type: "string",
        example: { type: "string", nullable: true },
        enum: ["a", "b"],
        default: "a",
      });
    });
  });

  describe("exclusiveMinimum / exclusiveMaximum (boolean → numeric)", () => {
    it("translates {minimum: N, exclusiveMinimum: true} to {exclusiveMinimum: N}", () => {
      const out = translateSchemaDialect(
        { type: "integer", minimum: 0, exclusiveMinimum: true },
        "3.0",
      );
      expect(out).toEqual({ type: "integer", exclusiveMinimum: 0 });
    });

    it("drops exclusiveMinimum: false, keeps minimum", () => {
      const out = translateSchemaDialect(
        { type: "integer", minimum: 0, exclusiveMinimum: false },
        "3.0",
      );
      expect(out).toEqual({ type: "integer", minimum: 0 });
    });

    it("preserves a numeric exclusiveMinimum (already 2020-12 form)", () => {
      const out = translateSchemaDialect(
        { type: "integer", exclusiveMinimum: 5 },
        "3.0",
      );
      expect(out).toEqual({ type: "integer", exclusiveMinimum: 5 });
    });

    it("drops exclusiveMinimum: true without paired minimum", () => {
      const out = translateSchemaDialect(
        { type: "integer", exclusiveMinimum: true },
        "3.0",
      );
      expect(out).toEqual({ type: "integer" });
    });

    it("applies same translations to maximum / exclusiveMaximum", () => {
      const out = translateSchemaDialect(
        { type: "integer", maximum: 100, exclusiveMaximum: true },
        "3.0",
      );
      expect(out).toEqual({ type: "integer", exclusiveMaximum: 100 });
    });
  });

  describe("PokéAPI shape — pagination response", () => {
    it("translates the PaginatedAbilitySummaryList shape", () => {
      const input = {
        type: "object",
        properties: {
          count: { type: "integer" },
          next: { type: "string", nullable: true, format: "uri" },
          previous: { type: "string", nullable: true, format: "uri" },
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                url: { type: "string", format: "uri" },
              },
            },
          },
        },
        required: ["count", "results"],
      };
      const out = translateSchemaDialect(input, "3.0");
      expect(out).toEqual({
        type: "object",
        properties: {
          count: { type: "integer" },
          next: { type: ["string", "null"], format: "uri" },
          previous: { type: ["string", "null"], format: "uri" },
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                url: { type: "string", format: "uri" },
              },
            },
          },
        },
        required: ["count", "results"],
      });
    });
  });

  describe("stray-nullable salvage (non-3.0 versions)", () => {
    // Parity with the Go synthesizer: the wild's 3.1 documents routinely
    // carry 3.0's removed nullable keyword (DRF pagination schemas via
    // drf-spectacular — PokeAPI ships 132 of them), and preserved verbatim
    // it silently rejects the very nulls the author declared.
    it("translates a stray 3.1 nullable and drops the keyword", () => {
      const input = {
        type: ["string", "null"],
        properties: { x: { type: "string", nullable: true, format: "uri" } },
      };
      const out = translateSchemaDialect(input, "3.1") as Record<string, unknown>;
      expect(out.type).toEqual(["string", "null"]);
      expect((out.properties as Record<string, unknown>).x).toEqual({
        type: ["string", "null"],
        format: "uri",
      });
    });

    it("drops a stray nullable without a type", () => {
      const input = {
        type: ["string", "null"],
        properties: { x: { nullable: true } },
      };
      const out = translateSchemaDialect(input, "3.1") as Record<string, unknown>;
      expect((out.properties as Record<string, unknown>).x).toEqual({});
    });

    it("leaves 3.1 exclusiveMinimum untouched (already numeric in 2020-12)", () => {
      const input = { type: "integer", exclusiveMinimum: 5 };
      const out = translateSchemaDialect(input, "3.1") as Record<string, unknown>;
      expect(out).toEqual({ type: "integer", exclusiveMinimum: 5 });
    });

    it("salvages nullable under unknown versions too", () => {
      const input = { type: "string", nullable: true };
      const out = translateSchemaDialect(input, "4.0") as Record<string, unknown>;
      expect(out).toEqual({ type: ["string", "null"] });
    });

    it("returns non-object schemas unchanged", () => {
      expect(translateSchemaDialect(true, "3.0")).toBe(true);
      expect(translateSchemaDialect(false, "3.0")).toBe(false);
      expect(translateSchemaDialect(null, "3.0")).toBe(null);
    });
  });

  describe("non-mutation", () => {
    it("does not mutate the input schema", () => {
      const input = {
        type: "object",
        properties: { x: { type: "string", nullable: true } },
      };
      const snapshot = JSON.parse(JSON.stringify(input));
      translateSchemaDialect(input, "3.0");
      expect(input).toEqual(snapshot);
    });
  });
});

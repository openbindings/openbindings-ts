/**
 * Reason-string alignment table: pins the EXACT diagnostic each directional
 * check produces, byte-identical with the Go SDK (the parity rule).
 * Mirrored in openbindings-go/schemaprofile/reasons_test.go — the two
 * tables carry the same fixtures and the same expected strings; a change on
 * one side must land on both.
 *
 * Conventions pinned here:
 *   - values and counts interpolate in JCS (RFC 8785) rendering — strings
 *     quoted, numbers in ECMAScript form;
 *   - the const/enum prefix names the DECIDING keyword: the keyword whose
 *     constraint rejects the flowing value (input: the candidate's; output:
 *     the target's);
 *   - exclusive bounds are marked ("exclusive 0");
 *   - unions carry the real union key and the failing variant index;
 *   - multi-member faults (types, enum values, required, properties) name
 *     the lexicographically FIRST failing member;
 *   - property/required member names and type names interpolate in the same
 *     JCS rendering as values (quoted, JSON-string escaping) — visible only
 *     for names carrying quotes, backslashes, or control characters; plain
 *     names render exactly as before;
 *   - tell-tale non-normalized inputs (scalar type, unresolved $ref,
 *     unflattened allOf) are refused loudly — see refusalCases below.
 */
import { describe, it, expect } from "vitest";
import { inputCompatible, outputCompatible } from "./compat.js";
import { NotNormalizedError } from "./errors.js";
import type { JSONObject } from "./helpers.js";

interface ReasonCase {
  name: string;
  direction: "input" | "output";
  target: string; // schema JSON (normalized form)
  candidate: string;
  reason: string; // expected exact reason; "" = compatible
}

const reasonCases: ReasonCase[] = [
  // --- type ---
  {
    name: "input type missing single",
    direction: "input",
    target: `{"type":["string","integer"]}`,
    candidate: `{"type":["string"]}`,
    reason: `type: candidate does not allow "integer"`,
  },
  {
    name: "input type missing multiple sorted",
    direction: "input",
    target: `{"type":["string","boolean","integer"]}`,
    candidate: `{"type":["number"]}`,
    reason: `type: candidate does not allow "boolean", "string"`,
  },
  {
    name: "output type extra",
    direction: "output",
    target: `{"type":["string"]}`,
    candidate: `{"type":["string","number"]}`,
    reason: `type: candidate allows "number" but target does not`,
  },
  {
    name: "input untyped target vs typed candidate",
    direction: "input",
    target: `{"minimum":1}`,
    candidate: `{"type":["number"]}`,
    reason: `type: candidate does not allow all types`,
  },
  {
    name: "output untyped candidate vs typed target",
    direction: "output",
    target: `{"type":["string"]}`,
    candidate: `{"minimum":1}`,
    reason: `type: candidate allows all types but target does not`,
  },

  // --- const/enum: input (deciding keyword = candidate's) ---
  {
    name: "input const vs const mismatch",
    direction: "input",
    target: `{"const":"a"}`,
    candidate: `{"const":"b"}`,
    reason: `const: candidate const "b" does not match target const "a"`,
  },
  {
    name: "input const vs enum missing",
    direction: "input",
    target: `{"const":"a"}`,
    candidate: `{"enum":["b","c"]}`,
    reason: `enum: target const "a" not in candidate enum`,
  },
  {
    name: "input enum vs const cannot cover",
    direction: "input",
    target: `{"enum":["a","b"]}`,
    candidate: `{"const":"a"}`,
    reason: `const: candidate const "a" cannot cover 2 target enum values`,
  },
  {
    name: "input single enum vs const mismatch",
    direction: "input",
    target: `{"enum":["a"]}`,
    candidate: `{"const":"b"}`,
    reason: `const: candidate const "b" not in target enum`,
  },
  {
    name: "input enum vs enum missing sorted",
    direction: "input",
    target: `{"enum":["b","a","c"]}`,
    candidate: `{"enum":["c"]}`,
    reason: `enum: target value "a" not in candidate enum`,
  },

  // --- const/enum: output (deciding keyword = target's) ---
  {
    name: "output enum vs const outside",
    direction: "output",
    target: `{"enum":["a"]}`,
    candidate: `{"const":"b"}`,
    reason: `enum: candidate const "b" not in target enum`,
  },
  {
    name: "output enum vs enum extra sorted",
    direction: "output",
    target: `{"enum":["a"]}`,
    candidate: `{"enum":["a","c","b"]}`,
    reason: `enum: candidate value "b" not in target enum`,
  },
  {
    name: "output enum vs unconstrained",
    direction: "output",
    target: `{"enum":["a"]}`,
    candidate: `{"type":["string"]}`,
    reason: `enum: candidate is unconstrained but target has enum`,
  },
  {
    name: "output const vs const mismatch",
    direction: "output",
    target: `{"const":"a"}`,
    candidate: `{"const":"b"}`,
    reason: `const: candidate const "b" does not match target const "a"`,
  },
  {
    name: "output const vs multi enum",
    direction: "output",
    target: `{"const":"a"}`,
    candidate: `{"enum":["a","b"]}`,
    reason: `const: candidate enum has 2 values but target allows only const "a"`,
  },
  {
    name: "output const vs single enum mismatch",
    direction: "output",
    target: `{"const":"a"}`,
    candidate: `{"enum":["b"]}`,
    reason: `const: candidate enum value does not match target const "a"`,
  },
  {
    name: "output const vs unconstrained",
    direction: "output",
    target: `{"const":"a"}`,
    candidate: `{"type":["string"]}`,
    reason: `const: candidate is unconstrained but target requires const "a"`,
  },
  {
    name: "const values render as JCS",
    direction: "input",
    target: `{"const":1}`,
    candidate: `{"const":2}`,
    reason: `const: candidate const 2 does not match target const 1`,
  },

  // --- Top / empty ---
  {
    name: "output empty candidate vs constrained target",
    direction: "output",
    target: `{"type":["string"]}`,
    candidate: `{}`,
    reason: `candidate is unconstrained but target is not`,
  },
  {
    name: "input constrained candidate vs Top target",
    direction: "input",
    target: `{}`,
    candidate: `{"type":["string"]}`,
    reason: `candidate is constrained but target is unconstrained (Top)`,
  },

  // --- objects ---
  {
    name: "input required extra sorted",
    direction: "input",
    target: `{"type":["object"]}`,
    candidate: `{"type":["object"],"required":["z","y"]}`,
    reason: `required: candidate requires "y" but target does not`,
  },
  {
    name: "output required missing",
    direction: "output",
    target: `{"type":["object"],"required":["a"]}`,
    candidate: `{"type":["object"]}`,
    reason: `required: target requires "a" but candidate does not`,
  },
  {
    name: "nested property prefix",
    direction: "input",
    target: `{"type":["object"],"properties":{"count":{"type":["integer"]}}}`,
    candidate: `{"type":["object"],"properties":{"count":{"type":["string"]}}}`,
    reason: `properties["count"]: type: candidate does not allow "integer"`,
  },
  {
    name: "multi-fault properties name first sorted",
    direction: "input",
    target: `{"type":["object"],"properties":{"b":{"type":["integer"]},"a":{"type":["integer"]}}}`,
    candidate: `{"type":["object"],"properties":{"b":{"type":["string"]},"a":{"type":["string"]}}}`,
    reason: `properties["a"]: type: candidate does not allow "integer"`,
  },
  {
    name: "output extra property against closed target",
    direction: "output",
    target: `{"type":["object"],"properties":{"a":{"type":["string"]}},"additionalProperties":false}`,
    candidate: `{"type":["object"],"properties":{"a":{"type":["string"]},"b":{"type":["string"]}}}`,
    reason: `properties["b"]: target forbids additional properties`,
  },
  {
    name: "output additionalProperties forbidden vs open",
    direction: "output",
    target: `{"type":["object"],"additionalProperties":false}`,
    candidate: `{"type":["object"]}`,
    reason: `additionalProperties: target forbids but candidate allows`,
  },
  {
    name: "output additionalProperties schema vs absent",
    direction: "output",
    target: `{"type":["object"],"additionalProperties":{"type":["string"]}}`,
    candidate: `{"type":["object"]}`,
    reason: `additionalProperties: candidate is less restrictive than target`,
  },

  // --- arrays ---
  {
    name: "items prefix",
    direction: "input",
    target: `{"type":["array"],"items":{"type":["string"]}}`,
    candidate: `{"type":["array"],"items":{"type":["number"]}}`,
    reason: `items: type: candidate does not allow "string"`,
  },

  // --- numeric bounds ---
  {
    name: "input minimum narrower",
    direction: "input",
    target: `{"type":["number"],"minimum":0}`,
    candidate: `{"type":["number"],"minimum":5}`,
    reason: `minimum: candidate minimum 5 is greater than target minimum 0`,
  },
  {
    name: "input exclusive minimum marked",
    direction: "input",
    target: `{"type":["number"],"minimum":0}`,
    candidate: `{"type":["number"],"exclusiveMinimum":0}`,
    reason: `minimum: candidate minimum exclusive 0 is greater than target minimum 0`,
  },
  {
    name: "output minimum missing",
    direction: "output",
    target: `{"type":["number"],"minimum":0}`,
    candidate: `{"type":["number"]}`,
    reason: `minimum: target has minimum 0 but candidate has none`,
  },
  {
    name: "output maximum wider",
    direction: "output",
    target: `{"type":["number"],"maximum":10}`,
    candidate: `{"type":["number"],"maximum":20}`,
    reason: `maximum: candidate maximum 20 is greater than target maximum 10`,
  },
  {
    name: "bounds render as JCS numbers",
    direction: "output",
    target: `{"type":["number"],"maximum":100000000}`,
    candidate: `{"type":["number"]}`,
    reason: `maximum: target has maximum 100000000 but candidate has none`,
  },
  {
    name: "fractional bound",
    direction: "output",
    target: `{"type":["number"],"minimum":2.5}`,
    candidate: `{"type":["number"]}`,
    reason: `minimum: target has minimum 2.5 but candidate has none`,
  },

  // --- string/array bounds ---
  {
    name: "input minLength narrower",
    direction: "input",
    target: `{"type":["string"],"minLength":1}`,
    candidate: `{"type":["string"],"minLength":2}`,
    reason: `minLength: candidate minLength 2 is greater than target minLength 1`,
  },
  {
    name: "output maxItems missing",
    direction: "output",
    target: `{"type":["array"],"maxItems":5}`,
    candidate: `{"type":["array"]}`,
    reason: `maxItems: target has maxItems 5 but candidate has none`,
  },

  // --- member-name escaping (JCS) ---
  {
    name: "property name with quote and backslash escapes as JCS",
    direction: "input",
    target: String.raw`{"type":["object"],"properties":{"wei\"rd\\name":{"type":["integer"]}}}`,
    candidate: String.raw`{"type":["object"],"properties":{"wei\"rd\\name":{"type":["string"]}}}`,
    reason: String.raw`properties["wei\"rd\\name"]: type: candidate does not allow "integer"`,
  },
  {
    name: "property name with control character escapes as JCS",
    direction: "input",
    target: String.raw`{"type":["object"],"properties":{"bad\u0001name":{"type":["integer"]}}}`,
    candidate: String.raw`{"type":["object"],"properties":{"bad\u0001name":{"type":["string"]}}}`,
    reason: String.raw`properties["bad\u0001name"]: type: candidate does not allow "integer"`,
  },
  {
    name: "required name with quote escapes as JCS",
    direction: "input",
    target: `{"type":["object"]}`,
    candidate: String.raw`{"type":["object"],"required":["say\"cheese"]}`,
    reason: String.raw`required: candidate requires "say\"cheese" but target does not`,
  },
  {
    // Type names join the member-name JCS canon (extension of the
    // 2026-07-20 member-name escaping ruling). The Go table adds this
    // identical case in parallel (schemaprofile/reasons_test.go) — keep the
    // two in lockstep. Plain lowercase type names are pinned unchanged by
    // the type cases at the top of this table.
    name: "type name with quote escapes as JCS",
    direction: "input",
    target: String.raw`{"type":["weird\"type"]}`,
    candidate: `{"type":["string"]}`,
    reason: String.raw`type: candidate does not allow "weird\"type"`,
  },

  // --- unions ---
  {
    name: "input union real key and index",
    direction: "input",
    target: `{"anyOf":[{"type":["string"]},{"type":["number"]}]}`,
    candidate: `{"anyOf":[{"type":["string"]}]}`,
    reason: `anyOf: target variant 1 has no compatible candidate variant`,
  },
  {
    name: "output union real key and index",
    direction: "output",
    target: `{"oneOf":[{"type":["string"]}]}`,
    candidate: `{"oneOf":[{"type":["string"]},{"type":["boolean"]}]}`,
    reason: `oneOf: candidate variant 1 has no compatible target variant`,
  },
  {
    name: "candidate union target not",
    direction: "input",
    target: `{"type":["string"]}`,
    candidate: `{"oneOf":[{"type":["string"]}]}`,
    reason: `oneOf: target is not a union but candidate is`,
  },
  {
    name: "target union candidate not",
    direction: "output",
    target: `{"oneOf":[{"type":["string"]}]}`,
    candidate: `{"type":["number"]}`,
    reason: `oneOf: candidate is not a union but target is`,
  },
];

describe("reason-string alignment (mirrors Go schemaprofile/reasons_test.go)", () => {
  for (const tc of reasonCases) {
    it(tc.name, () => {
      const tgt = JSON.parse(tc.target) as JSONObject;
      const cand = JSON.parse(tc.candidate) as JSONObject;
      const r =
        tc.direction === "input" ? inputCompatible(tgt, cand) : outputCompatible(tgt, cand);
      if (tc.reason === "") {
        expect(r.compatible).toBe(true);
        return;
      }
      expect(r.compatible).toBe(false);
      expect(r.reason).toBe(tc.reason);
    });
  }
});

/**
 * Non-normalized-input refusal table: pins the EXACT error each directional
 * check raises when handed a schema the Normalizer never emits (the inputs
 * MUST be pre-normalized contract). Byte-identical with the Go SDK's table
 * in reasons_test.go. The target is checked before the candidate; nested
 * walks visit properties (sorted), additionalProperties, items, then
 * oneOf/anyOf variants.
 */
interface RefusalCase {
  name: string;
  direction: "input" | "output";
  target: string; // schema JSON
  candidate: string;
  error: string; // expected exact error message
}

const refusalCases: RefusalCase[] = [
  {
    name: "scalar type target refused",
    direction: "input",
    target: `{"type":"string"}`,
    candidate: `{"type":["string"]}`,
    error: `not normalized at target: keyword "type" must be an array`,
  },
  {
    name: "scalar type candidate refused",
    direction: "output",
    target: `{"type":["string"]}`,
    candidate: `{"type":"string"}`,
    error: `not normalized at candidate: keyword "type" must be an array`,
  },
  {
    name: "unresolved nested $ref refused",
    direction: "input",
    target: `{"type":["object"],"properties":{"a":{"$ref":"#/schemas/A"}}}`,
    candidate: `{"type":["object"]}`,
    error: `not normalized at target.properties["a"]: keyword "$ref" must be resolved`,
  },
  {
    name: "unflattened allOf refused",
    direction: "output",
    target: `{"type":["object"]}`,
    candidate: `{"allOf":[{"type":["object"]}]}`,
    error: `not normalized at candidate: keyword "allOf" must be flattened`,
  },
];

describe("non-normalized refusal alignment (mirrors Go schemaprofile/reasons_test.go)", () => {
  for (const tc of refusalCases) {
    it(tc.name, () => {
      const tgt = JSON.parse(tc.target) as JSONObject;
      const cand = JSON.parse(tc.candidate) as JSONObject;
      let thrown: unknown;
      try {
        if (tc.direction === "input") inputCompatible(tgt, cand);
        else outputCompatible(tgt, cand);
      } catch (e: unknown) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(NotNormalizedError);
      expect((thrown as Error).message).toBe(tc.error);
    });
  }
});

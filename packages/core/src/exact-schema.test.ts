import { describe, expect, it } from "vitest";
import { parse } from "@openbindings/json";
import { compileEmbeddedSchema } from "./schema-validation.js";

describe("exact schema predicates and diagnostics", () => {
  for (const [schema, input, valid] of [
    ['{"minimum":9007199254740993}', '9007199254740992', false],
    ['{"minimum":9007199254740993}', '9007199254740993', true],
    ['{"const":0.10000000000000000001}', '0.1', false],
    ['{"type":"integer"}', '1e400', true],
    ['{"type":"object"}', '0.1', false],
    ['{"multipleOf":0.1}', '0.3', true],
    ['{"uniqueItems":true}', '[1,1.00]', false],
    ['{"contains":true,"minContains":1.00}', '[]', false],
    ['{"contains":false,"minContains":0.0}', '[1]', true],
  ] as const) it(`${schema} / ${input}`, () => {
    expect(compileEmbeddedSchema(parse(schema)).validate(parse(input)).valid).toBe(valid);
  });
  for (const schema of ['{"const":1}', '{"type":"string"}', '{"enum":[1]}',
    '{"maximum":1}', '{"not":true}', '{"oneOf":[{"type":"string"}]}',
    '{"anyOf":[{"type":"string"}]}']) it(`truthful message ${schema}`, () => {
    const result = compileEmbeddedSchema(parse(schema)).validate(parse('9007199254740993'));
    expect(result.valid).toBe(false);
    expect(result.failures[0]!.message).toContain('9007199254740993');
    expect(result.failures[0]!.message).not.toMatch(/rawJSON|isLosslessNumber/);
    expect(result.failures[0]!.schemaPath).toBeDefined();
  });
});

import { describe, it, expect } from "vitest";
import { compileEmbeddedSchema } from "../../packages/core/src/schema-validation.js";

// Real gate, not skipped tests or tests that expect a defect. These are
// standard 2020-12 occurrence-count semantics, not an SDK quality extension.
describe("validator qualification — boolean contains occurrence counts", () => {
  const cases = [
    [{ contains: false, minContains: 0 }, [], true],
    [{ contains: true, minContains: 0 }, [], true],
    [{ contains: true, minContains: 2 }, [1], false],
    [{ contains: true, maxContains: 0 }, [1], false],
  ] as const;
  for (const [schema, data, expected] of cases) it(JSON.stringify(schema), () => {
    expect(compileEmbeddedSchema(schema).validate(data).valid).toBe(expected);
  });
  for (const contains of [true, false, { const: 1 }]) {
    for (const minContains of [undefined, 0, 1, 2]) {
      for (const maxContains of [undefined, 0, 1, 2]) {
        for (const data of [[], [1], [2], [1, 2], [1, 1]]) {
          const count = contains === true ? data.length : contains === false ? 0 : data.filter(n => n === 1).length;
          const expected = count >= (minContains ?? 1) && count <= (maxContains ?? Infinity);
          const schema = { contains, ...(minContains === undefined ? {} : { minContains }), ...(maxContains === undefined ? {} : { maxContains }) };
          it(JSON.stringify({ schema, data }), () => {
            const validator = compileEmbeddedSchema(schema);
            for (let repeat = 0; repeat < 3; repeat++) expect(validator.validate(data).valid).toBe(expected);
          });
        }
      }
    }
  }
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { compileSchema, draft2020 } from "json-schema-library";

type Case = { id: string; schemaJSON: string; instanceJSON: string; expected: boolean };
const cases = JSON.parse(readFileSync(new URL(
  "../../../third_party/json-schema-library/regressions.json", import.meta.url,
), "utf8")) as Case[];

describe("private validator correction — upstream semantic regression floor", () => {
  it("retains the entire non-numeric correction corpus", () => expect(cases).toHaveLength(54));
  for (const c of cases) it(c.id, () => {
    const schema = JSON.parse(c.schemaJSON), value = JSON.parse(c.instanceJSON);
    const before = JSON.stringify({ schema, value });
    const node = compileSchema(schema, { drafts: [draft2020], throwOnInvalidRef: true });
    expect(node.schemaErrors).toHaveLength(0);
    for (let repeat = 0; repeat < 3; repeat++) expect(node.validate(value).valid).toBe(c.expected);
    expect(JSON.stringify({ schema, value })).toBe(before);
  });
});

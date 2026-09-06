import { compileSchema, draft2020 } from "json-schema-library";
import { describe, expect, it } from "vitest";
import obiSchema from "./openbindings.schema.json" with { type: "json" };
import { validateAgainstOBISchema } from "./schema-validation.js";

const BASE: Record<string, unknown> = {
  openbindings: "0.2.0",
  name: "example",
  version: "1",
  description: "example",
  schemas: { Value: { type: "string" } },
  operations: {
    op: {
      description: "operation",
      deprecated: false,
      tags: ["a"],
      aliases: ["example.op"],
      idempotent: true,
      input: true,
      output: { type: "string" },
      examples: { good: { description: "example", input: null, output: "x" } },
    },
  },
  dependencies: { dep: { operation: "op", bindingSpecs: ["example@1"] } },
  sources: {
    remote: { bindingSpec: "example@1", location: "https://example.test", description: "source" },
    embedded: { bindingSpec: "example@1", content: null },
  },
  bindings: {
    binding: {
      operation: "op",
      source: "remote",
      selector: "target",
      preference: 1,
      description: "binding",
      deprecated: false,
      inputTransform: "$",
      outputTransform: { $ref: "#/transforms/pass", extension: true },
    },
  },
  transforms: { pass: "$" },
  extension: true,
};

function changed(mutator: (value: Record<string, unknown>) => void): unknown {
  const value = structuredClone(BASE);
  mutator(value);
  return value;
}

const cases: [string, unknown, boolean][] = [
  ["complete valid document", BASE, true],
  ["optional undefined fields are absent", changed(value => {
    const operation = (value.operations as Record<string, Record<string, unknown>>).op!;
    operation.description = undefined;
    operation.deprecated = undefined;
  }), true],
  ["root type", [], false],
  ["openbindings required", changed(value => { delete value.openbindings; }), false],
  ["openbindings type", changed(value => { value.openbindings = 2; }), false],
  ["openbindings semver", changed(value => { value.openbindings = "v2"; }), false],
  ["name type", changed(value => { value.name = false; }), false],
  ["version nonempty", changed(value => { value.version = ""; }), false],
  ["operations required", changed(value => { delete value.operations; }), false],
  ["operations map", changed(value => { value.operations = []; }), false],
  ["operation value", changed(value => { (value.operations as Record<string, unknown>).op = null; }), false],
  ["operation key", changed(value => { (value.operations as Record<string, unknown>)["bad key"] = {}; }), false],
  ["operation description", changed(value => { ((value.operations as Record<string, unknown>).op as Record<string, unknown>).description = 1; }), false],
  ["operation deprecated", changed(value => { ((value.operations as Record<string, unknown>).op as Record<string, unknown>).deprecated = "no"; }), false],
  ["operation tags", changed(value => { ((value.operations as Record<string, unknown>).op as Record<string, unknown>).tags = [1]; }), false],
  ["operation alias unique", changed(value => { ((value.operations as Record<string, unknown>).op as Record<string, unknown>).aliases = ["same", "same"]; }), false],
  ["operation alias pattern", changed(value => { ((value.operations as Record<string, unknown>).op as Record<string, unknown>).aliases = ["bad key"]; }), false],
  ["operation idempotent", changed(value => { ((value.operations as Record<string, unknown>).op as Record<string, unknown>).idempotent = 1; }), false],
  ["operation input null", changed(value => { ((value.operations as Record<string, unknown>).op as Record<string, unknown>).input = null; }), false],
  ["schema boolean", changed(value => { (value.schemas as Record<string, unknown>).Value = false; }), true],
  ["schema member form", changed(value => { (value.schemas as Record<string, unknown>).Value = 1; }), false],
  ["schema dialect", changed(value => { (value.schemas as Record<string, unknown>).Value = { $schema: "draft-07" }; }), false],
  ["schema vocabulary forbidden", changed(value => { (value.schemas as Record<string, unknown>).Value = { $vocabulary: {} }; }), false],
  ["example map", changed(value => { ((value.operations as Record<string, unknown>).op as Record<string, unknown>).examples = []; }), false],
  ["example value", changed(value => { (((value.operations as Record<string, unknown>).op as Record<string, unknown>).examples as Record<string, unknown>).good = false; }), false],
  ["dependency operation required", changed(value => { delete ((value.dependencies as Record<string, unknown>).dep as Record<string, unknown>).operation; }), false],
  ["dependency operation pattern", changed(value => { ((value.dependencies as Record<string, unknown>).dep as Record<string, unknown>).operation = "bad key"; }), false],
  ["dependency specs nonempty", changed(value => { ((value.dependencies as Record<string, unknown>).dep as Record<string, unknown>).bindingSpecs = []; }), false],
  ["dependency specs unique", changed(value => { ((value.dependencies as Record<string, unknown>).dep as Record<string, unknown>).bindingSpecs = ["x", "x"]; }), false],
  ["dependency spec string", changed(value => { ((value.dependencies as Record<string, unknown>).dep as Record<string, unknown>).bindingSpecs = [1]; }), false],
  ["source binding spec", changed(value => { ((value.sources as Record<string, unknown>).remote as Record<string, unknown>).bindingSpec = ""; }), false],
  ["source location type", changed(value => { ((value.sources as Record<string, unknown>).remote as Record<string, unknown>).location = 1; }), false],
  ["source carriage", changed(value => { const source = (value.sources as Record<string, unknown>).remote as Record<string, unknown>; delete source.location; delete source.content; }), false],
  ["present null content", changed(value => { (value.sources as Record<string, unknown>).remote = { bindingSpec: "x", content: null }; }), true],
  ["binding operation required", changed(value => { delete ((value.bindings as Record<string, unknown>).binding as Record<string, unknown>).operation; }), false],
  ["binding source pattern", changed(value => { ((value.bindings as Record<string, unknown>).binding as Record<string, unknown>).source = "bad key"; }), false],
  ["binding selector type", changed(value => { ((value.bindings as Record<string, unknown>).binding as Record<string, unknown>).selector = 1; }), false],
  ["binding preference integer", changed(value => { ((value.bindings as Record<string, unknown>).binding as Record<string, unknown>).preference = 1.5; }), false],
  ["binding preference safe", changed(value => { ((value.bindings as Record<string, unknown>).binding as Record<string, unknown>).preference = Number.MAX_SAFE_INTEGER + 1; }), false],
  ["binding transform reference", changed(value => { ((value.bindings as Record<string, unknown>).binding as Record<string, unknown>).inputTransform = { $ref: "elsewhere" }; }), false],
  ["transform value", changed(value => { (value.transforms as Record<string, unknown>).pass = {}; }), false],
];

describe("single-pass openbindings.schema.json evaluator", () => {
  const reference = compileSchema(obiSchema, {
    drafts: [{ ...draft2020, formats: {} }],
  });

  it.each(cases)("matches the derived schema: %s", (_name, value, expected) => {
    const errs: string[] = [];
    validateAgainstOBISchema(errs, value);
    const actual = errs.length === 0;
    const oracle = reference.validate(value).valid;
    expect(oracle).toBe(expected);
    expect(actual).toBe(oracle);
    if (!actual) expect(errs.every(error => error.endsWith("(OBI-D-02)"))).toBe(true);
  });
});

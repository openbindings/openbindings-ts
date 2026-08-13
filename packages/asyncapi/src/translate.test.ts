import { describe, expect, it } from "vitest";
import { translateSchemaDialect } from "./translate.js";

// Twin of the Go SDK's TestTranslateSchemaDialect: one case per
// authority-derived dialect cell. The two tables must stay aligned.
describe("translateSchemaDialect", () => {
  const cases: Array<[string, string, string]> = [
    [
      "tuple items become prefixItems",
      `{"type":"array","items":[{"type":"string"},{"type":"integer"}]}`,
      `{"type":"array","prefixItems":[{"type":"string"},{"type":"integer"}]}`,
    ],
    [
      "additionalItems with a tuple becomes items",
      `{"type":"array","items":[{"type":"string"}],"additionalItems":{"type":"integer"}}`,
      `{"type":"array","prefixItems":[{"type":"string"}],"items":{"type":"integer"}}`,
    ],
    [
      "additionalItems without a tuple was inert and drops",
      `{"type":"array","items":{"type":"string"},"additionalItems":{"type":"integer"}}`,
      `{"type":"array","items":{"type":"string"}}`,
    ],
    [
      "dependencies split into dependentRequired and dependentSchemas",
      `{"dependencies":{"card":["cvv"],"billing":{"required":["address"]}}}`,
      `{"dependentRequired":{"card":["cvv"]},"dependentSchemas":{"billing":{"required":["address"]}}}`,
    ],
    [
      "$schema drops",
      `{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}`,
      `{"type":"object"}`,
    ],
    [
      "plain-name fragment $id becomes $anchor",
      `{"$id":"#MassCancelResponse","type":"object"}`,
      `{"$anchor":"MassCancelResponse","type":"object"}`,
    ],
    ["relative $id drops", `{"$id":"GeneralReply","type":"object"}`, `{"type":"object"}`],
    ["pointer-form $id drops", `{"$id":"#/properties/driver","type":"object"}`, `{"type":"object"}`],
    [
      "absolute $id keeps",
      `{"$id":"https://example.com/schemas/task","type":"object"}`,
      `{"$id":"https://example.com/schemas/task","type":"object"}`,
    ],
    [
      "assertion siblings of $ref drop, annotations keep",
      `{"$ref":"https://example.com/x.json","maxLength":5,"description":"kept"}`,
      `{"$ref":"https://example.com/x.json","description":"kept"}`,
    ],
    [
      "literal keywords are never entered",
      `{"enum":[{"items":[1,2]}],"const":{"$schema":"x"},"default":{"dependencies":{}}}`,
      `{"enum":[{"items":[1,2]}],"const":{"$schema":"x"},"default":{"dependencies":{}}}`,
    ],
    [
      "map-of-schema members translate regardless of member name",
      `{"properties":{"enum":{"items":[{"type":"string"}]},"const":{"$schema":"y","type":"integer"}}}`,
      `{"properties":{"enum":{"prefixItems":[{"type":"string"}]},"const":{"type":"integer"}}}`,
    ],
    [
      "unknown and AsyncAPI-extension keywords pass through",
      `{"discriminator":"kind","x-custom":{"items":[1]},"externalDocs":{"url":"https://example.com"}}`,
      `{"discriminator":"kind","x-custom":{"items":[1]},"externalDocs":{"url":"https://example.com"}}`,
    ],
    [
      "nested translation reaches combinators and items",
      `{"anyOf":[{"items":[{"type":"string"}]}],"not":{"$schema":"z","dependencies":{"a":["b"]}}}`,
      `{"anyOf":[{"prefixItems":[{"type":"string"}]}],"not":{"dependentRequired":{"a":["b"]}}}`,
    ],
  ];

  for (const [name, input, want] of cases) {
    it(name, () => {
      expect(translateSchemaDialect(JSON.parse(input))).toEqual(JSON.parse(want));
    });
  }
});

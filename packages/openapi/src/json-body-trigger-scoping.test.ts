// The §9.1 JSON-body trigger-scoping case table, shared byte-identically
// with the Go adapter and both openapi-client engines
// (testdata/json-body-trigger-scoping-cases.json). This package owns
// SYNTHESIS, so the cells are asserted through the shipped synthesizer: a
// whole cell publishes the one protocol-neutral `payload` operation property
// and an inputTransform carrying "whole":"payload"; a flattened cell
// publishes the artifact's own `value` property and no `payload`.
//
// Two rules ride the same cells. The trigger keywords are read under the
// GOVERNING EDITION'S dialect: on the 3.0 line patternProperties, if, then,
// else, dependentSchemas and unevaluatedProperties are not in the Schema
// Object dialect at all and decide as if absent, while oneOf, anyOf, not and
// additionalProperties decide alike on both lines. And an explicit
// unevaluatedProperties triggers on ANY value, the `false` spelling
// included.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BINDING_SPEC } from "./constants.js";
import { OpenAPISynthesizer } from "./invoker.js";

interface JSONBodyTriggerCase {
  name: string;
  openapi: string;
  line: string;
  keyword: string;
  presence: string;
  schema: Record<string, unknown>;
  expect: "whole" | "flattened";
}

const table = JSON.parse(readFileSync(
  new URL("./testdata/json-body-trigger-scoping-cases.json", import.meta.url),
  "utf8",
)) as { cases: JSONBodyTriggerCase[] };

function document(fixture: JSONBodyTriggerCase): Record<string, unknown> {
  return {
    openapi: fixture.openapi,
    info: { title: "json body trigger scoping", version: "1" },
    servers: [{ url: "https://fixture.invalid" }],
    paths: {
      "/items": {
        post: {
          operationId: "createItem",
          requestBody: {
            required: true,
            content: { "application/json": { schema: fixture.schema } },
          },
          responses: { "204": { description: "stored" } },
        },
      },
    },
  };
}

describe("language-neutral §9.1 JSON-body trigger scoping (synthesis)", () => {
  expect(table.cases.length).toBeGreaterThan(0);
  for (const fixture of table.cases) {
    it(fixture.name, async () => {
      expect(["whole", "flattened"]).toContain(fixture.expect);
      const iface = await new OpenAPISynthesizer().synthesizeInterface({
        sources: [{ bindingSpec: BINDING_SPEC, content: document(fixture) }],
      });
      const properties = (iface.operations.createItem?.input as
        | { properties?: Record<string, unknown> }
        | undefined)?.properties ?? {};
      const transform = iface.bindings?.["createItem.openapi"]?.inputTransform ?? "";
      if (fixture.expect === "whole") {
        expect(properties.payload).toBeDefined();
        expect(properties.value).toBeUndefined();
        expect(transform).toContain('"whole":"payload"');
        return;
      }
      expect(properties.value).toBeDefined();
      expect(properties.payload).toBeUndefined();
      expect(transform).not.toContain('"whole":"payload"');
    });
  }
});

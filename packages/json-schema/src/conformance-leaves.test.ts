// The mandatory 2020-12 suite through the public entry: every instance parsed
// by the codec (exact numbers), and again with every canonical Base64 string
// stored as an Encoded leaf. The registry for remote references is compiled
// with the same fixed draft through the package's internal module.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { remotes } from "json-schema-library/remotes";
import * as json from "@openbindings/json";
import { compile, compileSchema } from "./index.js";
import { draft } from "./draft.js";

const directory = new URL("../test-suite/", import.meta.url);
const source = JSON.parse(readFileSync(new URL("SOURCE.json", directory), "utf8")) as { files: Record<string, string> };
const registry = compileSchema({ $id: "https://leaf.invalid/registry" }, { drafts: [draft] });
for (const schema of remotes) registry.addRemoteSchema(schema.$id ?? schema.id, structuredClone(schema));
for (const file of Object.keys(source.files).filter(file => file.startsWith("remotes/"))) {
  registry.addRemoteSchema("http://localhost:1234/" + file.slice("remotes/".length), json.parse(readFileSync(new URL(file, directory), "utf8")));
}

// The same logical instance with Base64 text held as bytes. Buffer is an
// independent Base64 oracle in this Node-only qualification.
function withLeaves(value: unknown): unknown {
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") === value) return json.base64(bytes);
  }
  if (Array.isArray(value)) return value.map(withLeaves);
  if (value !== null && typeof value === "object" && !json.isDecimal(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, withLeaves(child)]));
  }
  return value;
}

describe("JSON Schema 2020-12 mandatory suite through compile", () => {
  const files = Object.keys(source.files).filter(file => file.startsWith("tests/draft2020-12/"));
  for (const file of files) {
    const groups = json.parse<{ schema: json.Value; description: string; tests: { description: string; data: json.Value; valid: boolean }[] }[]>(readFileSync(new URL(file, directory), "utf8"));
    for (const group of groups) {
      for (const test of group.tests) {
        it(`${file}: ${group.description}: ${test.description}`, () => {
          const schema = compile(group.schema, { remote: registry });
          expect(schema.validate(test.data).valid, "plain data with exact numbers").toBe(test.valid);
          expect(schema.validate(withLeaves(test.data) as json.Value).valid, "canonical Base64 strings held as Encoded leaves").toBe(test.valid);
        });
      }
    }
  }
});

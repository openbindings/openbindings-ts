import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { remotes } from "json-schema-library/remotes";
import { isJSONNumber, parseJSON } from "@openbindings/json";
import { arrayValue, bytesValue, recordValue, retain } from "@openbindings/json/values";
import type { RetainedValue } from "@openbindings/json/values";
import { compileSchema, compileValueSchema, RETAINED_DRAFT_2020 } from "./index.js";

const directory = new URL("../test-suite/", import.meta.url);
const source = JSON.parse(readFileSync(new URL("SOURCE.json", directory), "utf8"));
for (const [file, hash] of Object.entries(source.files)) {
  expect(createHash("sha256").update(readFileSync(new URL(file,directory))).digest("hex"), file).toBe(hash);
}
const registry = compileSchema({$id:"https://retained.invalid/registry"},{drafts:[RETAINED_DRAFT_2020]});
for (const schema of remotes) registry.addRemoteSchema(schema.$id ?? schema.id, structuredClone(schema));
for (const file of Object.keys(source.files).filter(file=>file.startsWith("remotes/"))) {
  registry.addRemoteSchema("http://localhost:1234/"+file.slice("remotes/".length),parseJSON(readFileSync(new URL(file,directory),"utf8")) as Parameters<typeof compileSchema>[0]);
}

// A second physical representation of exactly the same logical instance.
// Buffer is an independent Base64 oracle in this Node-only qualification.
function withByteStrings(value: unknown): RetainedValue {
  if (typeof value === "string") {
    const bytes=Buffer.from(value,"base64");
    if(bytes.toString("base64")===value) return bytesValue(bytes);
  }
  if(Array.isArray(value)) return arrayValue(value.map(withByteStrings));
  if(value !== null && typeof value === "object" && !isJSONNumber(value)) {
    return recordValue(Object.fromEntries(Object.entries(value).map(([key, child])=>[key,withByteStrings(child)])));
  }
  return retain(value);
}

describe("retained JSON Schema 2020-12 mandatory suite", () => {
  const files=Object.keys(source.files).filter(file=>file.startsWith("tests/draft2020-12/"));
  for(const file of files) {
    const groups=parseJSON(readFileSync(new URL(file,directory),"utf8")) as unknown as {
      schema:Parameters<typeof compileSchema>[0]; description:string;
      tests:{description:string;data:unknown;valid:boolean}[];
    }[];
    for(const group of groups) {
      for(const test of group.tests) {
        it(`${file}: ${group.description}: ${test.description}`, () => {
          const validator=compileValueSchema(group.schema,{remote:registry,throwOnInvalidRef:true});
          expect(validator.validate(retain(test.data)).valid,"ordinary scalar storage").toBe(test.valid);
          expect(validator.validate(withByteStrings(test.data)).valid,"canonical Base64 strings backed by bytes").toBe(test.valid);
        });
      }
    }
  }
});

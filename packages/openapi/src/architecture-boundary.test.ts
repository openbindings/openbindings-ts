import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const ADAPTER_FILES = new Set([
  "constants.ts",
  "index.ts",
  "input-routes-v2.ts",
  "invoker.ts",
  "native-invoker.ts",
  "platform.ts",
  "swagger20-synthesis.ts",
  "synthesizer.ts",
  "test-helpers.ts",
  "types.ts",
  "util.ts",
]);

describe("OpenAPI adapter architecture boundary", () => {
  it("contains only the reviewed translation surface", async () => {
    const directory = new URL("./", import.meta.url);
    const production = (await readdir(directory))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
      .sort();
    expect(production).toEqual([...ADAPTER_FILES].sort());

    for (const name of production) {
      const source = await readFile(new URL(name, directory), "utf8");
      expect(source, `${name} must not import a private client path`)
        .not.toMatch(/@openbindings\/openapi-client\/(?!provider["'])/u);
      expect(source, `${name} must not import the client's implementation dependencies`)
        .not.toMatch(/(?:kin-openapi|json-schema-library)/u);
    }
  });
});

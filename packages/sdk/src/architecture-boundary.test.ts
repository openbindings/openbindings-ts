import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("SDK runtime architecture boundary", () => {
  it("contains only protocol-neutral production sources", async () => {
    const directory = new URL("./", import.meta.url);
    const production = (await readdir(directory))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"));
    expect(production.sort()).toEqual(["index.ts", "runtime.ts"]);
    for (const name of production) {
      const source = await readFile(new URL(name, directory), "utf8");
      expect(source, `${name} imports a binding implementation`).not.toMatch(
        /@openbindings\/(?:openapi|asyncapi|grpc|connect|graphql|mcp|usage|operationgraph)(?:["'/])/u,
      );
      expect(source, `${name} imports a native artifact client`).not.toMatch(/openapi-client|asyncapi-client/u);
    }
  });
});

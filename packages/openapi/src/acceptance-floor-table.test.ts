// The shared acceptance-floor case table (block 8d-1) embeds in FOUR trees:
// openapi-client/go, openapi-client/typescript, openbindings-go/formats/openapi,
// and this package. Three of them pinned its digest; this one carried the file
// with nothing asserting it, so a table change could land here silently while
// the other three refused it. Round R closes that: the digest is now pinned in
// every tree that carries the file, and a change to the shared answer must land
// in all four simultaneously.
//
// This package consumes the floor through `@openbindings/openapi-client`, so
// the case expectations themselves are executed by the client's own port
// (`acceptance-floor.test.ts` there) and by both Go ports. What is asserted
// here is the one thing this tree can assert on its own: that the bytes it
// carries are the shared bytes.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CASE_TABLE_SHA256 = "53d53b3f43e3ca88e0788e3cff2d45be9b9c50cc90eb0d4702f9712a51e277a1";
const SHAPE_TABLE_SHA256 = "4e8f5393e48868e2a9468d7232921e1c2f3b33efd941f605b9e328b23191d456";

const tablePath = fileURLToPath(
  new URL("../testdata/acceptance-floor-case-table.json", import.meta.url),
);
const tableBytes = readFileSync(tablePath);

describe("shared acceptance-floor case table", () => {
  it("carries the pinned digests", () => {
    expect(createHash("sha256").update(tableBytes).digest("hex")).toBe(CASE_TABLE_SHA256);
    const table = JSON.parse(tableBytes.toString("utf8")) as {
      generatedFrom: { shapeTableSha256: string };
      mechanisms: unknown[];
      shapeCells: unknown[];
    };
    expect(table.generatedFrom.shapeTableSha256).toBe(SHAPE_TABLE_SHA256);
    expect(table.mechanisms).toHaveLength(8);
    expect(table.shapeCells).toHaveLength(68);
  });
});

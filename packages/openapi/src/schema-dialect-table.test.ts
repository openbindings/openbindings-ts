// Executes the shared Schema Object dialect case table
// (testdata/schema-object-dialect-cases.json) through the SHIPPED synthesis
// path: the floor's verdict has to reach a consumer as a coverage entry, not
// merely exist inside the instrument. The same file, at the same digest,
// embeds in openapi-client/go, openapi-client/typescript,
// openbindings-go/formats/openapi and this package: four engines, one answer.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OpenAPISynthesizer } from "./test-helpers.js";

// The embedded table's own digest. A change here is a change to the shared
// answer and must land in every engine simultaneously.
const SCHEMA_OBJECT_DIALECT_TABLE_SHA256 = "f3b84e690c1a77cd7710a704876ebc00129824dd8ec11a011c9b447dcde1b58c";

interface SchemaDialectCell {
  id: string;
  line: "3.0" | "3.1";
  openapi: string;
  schema: Record<string, unknown>;
  positions: Array<{ position: string; class: string }>;
  disposition: "represented" | "invalid";
  downstream: "coverage" | "obi-invalid" | "go-loader-refusal";
  downstreamNote?: string;
  why: string;
}

const SUBJECT_REF = "#/paths/~1a/get";
const CLEAN_REF = "#/paths/~1b/get";

const raw = readFileSync(new URL("./testdata/schema-object-dialect-cases.json", import.meta.url), "utf8");
const digest = createHash("sha256").update(raw).digest("hex");
if (digest !== SCHEMA_OBJECT_DIALECT_TABLE_SHA256) {
  throw new Error(
    `shared dialect case table digest ${digest}, pinned ${SCHEMA_OBJECT_DIALECT_TABLE_SHA256}: the table changed without a simultaneous four-engine landing`,
  );
}
const cells = (JSON.parse(raw) as { cells: SchemaDialectCell[] }).cells;

function document(cell: SchemaDialectCell): Record<string, unknown> {
  const response = (schema: unknown) => ({
    "200": { description: "ok", content: { "application/json": { schema } } },
  });
  return {
    openapi: cell.openapi,
    info: { title: "schema object dialect", version: "1" },
    paths: {
      "/a": { get: { responses: response(cell.schema) } },
      "/b": { get: { responses: response({ type: "object" }) } },
    },
  };
}

describe("the shared Schema Object dialect case table, through synthesis", () => {
  for (const cell of cells) {
    it(cell.id, async () => {
      const synthesize = () =>
        new OpenAPISynthesizer().synthesizeInterfaceWithCoverage({
          name: "dialect",
          sources: [{ bindingSpec: "openbindings.openapi-3.1@1", name: "dialect", content: document(cell), embed: true }],
        });

      // One cell class never reaches coverage at the current heads, for a
      // reason the table names and one this class does not own: a 3.0 document
      // the floor correctly leaves alone whose translated OBI still fails
      // OBI-D-17. `go-loader-refusal` is the Go adapter's own typed-loader
      // gate and does not exist here, so those cells run normally — which is
      // exactly the divergence the table records.
      if (cell.downstream === "obi-invalid") {
        await expect(
          synthesize(),
          `the cell is pinned as obi-invalid and the synthesis succeeded: the filed defect is fixed and the table must be updated in every engine\n${cell.downstreamNote ?? ""}`,
        ).rejects.toThrow();
        return;
      }

      const result = await synthesize();
      const targets = new Map<string, string>();
      for (const entry of result.coverage?.entries ?? []) {
        if (entry.scope !== "target") continue;
        targets.set(entry.sourceRef, `${entry.status} ${entry.reasonCode ?? ""}`.trim());
      }
      expect(targets.get(SUBJECT_REF), cell.why).toBe(
        cell.disposition === "invalid" ? "invalid openapi.invalid_unit" : "represented",
      );
      expect(targets.get(CLEAN_REF), "the clean sibling operation lost its target").toBe("represented");
    });
  }
});

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadOpenAPIDocument } from "./media.js";

// The shared case table, executed here against the BUILT
// `@openbindings/openapi-client` dist that this package re-exports — not
// against that package's `src`. The distinction is the point: a `src` edit is
// invisible to this package until the client is rebuilt, so this file is what
// proves the shipped re-export resolves scalars the same way the two Go
// engines do. The file is byte-identical to the copies in
// openbindings-go/formats/openapi/testdata, openapi-client/go/testdata and
// openapi-client/typescript/src/testdata.
export const YAML_SCALAR_RESOLUTION_CASES_DIGEST =
  "548cc220c706cd6ede805cc084872e19f1b9a4a88c595b54933597c52524a4f4";

export interface YAMLScalarResolutionCase {
  name: string;
  position: "value" | "key" | "merge";
  spelling: string;
  outcome: "resolved" | "source-refused";
  image: string | null;
  basis: string;
}

function loadCases(raw: Buffer): YAMLScalarResolutionCase[] {
  const digest = createHash("sha256").update(raw).digest("hex");
  if (digest !== YAML_SCALAR_RESOLUTION_CASES_DIGEST) {
    throw new Error(
      `case table digest = ${digest}, want ${YAML_SCALAR_RESOLUTION_CASES_DIGEST} (the table is shared byte-for-byte with the twin engines)`,
    );
  }
  const table = JSON.parse(raw.toString("utf8")) as { cases: YAMLScalarResolutionCase[] };
  if (table.cases.length === 0) throw new Error("case table is empty");
  return table.cases;
}

/** Render one case as a WHOLE OpenAPI document, in YAML — the grammar under test. */
function documentFor(c: YAMLScalarResolutionCase): string {
  let body: string;
  switch (c.position) {
    case "key":
      body = `  x-case:\n    ${c.spelling}: marker\n`;
      break;
    case "merge":
      body = `  x-anchor: &anchor\n    x: 1\n  x-case:\n    ${c.spelling}: *anchor\n    y: 2\n`;
      break;
    default:
      body = `  x-case: ${c.spelling}\n`;
  }
  return (
    "openapi: 3.1.0\n"
    + "info:\n"
    + "  title: yaml scalar resolution case table\n"
    + "  version: 1.0.0\n"
    + body
    + "paths:\n"
    + "  /p:\n"
    + "    get:\n"
    + "      operationId: getP\n"
    + "      responses:\n"
    + '        "200":\n'
    + "          description: ok\n"
  );
}

/** Canonical JSON with object keys sorted — the Go twin's `json.Marshal` order. */
function canonicalImage(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalImage).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalImage((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

const cases = loadCases(
  readFileSync(new URL("./testdata/yaml-scalar-resolution-cases.json", import.meta.url)),
);

describe("YAML 1.2.2 §10.3.2 scalar resolution through the built client dist", () => {
  for (const c of cases) {
    it(`${c.name} — ${c.outcome}`, async () => {
      let image: string;
      try {
        const document = (await loadOpenAPIDocument(undefined, documentFor(c))) as {
          info?: Record<string, unknown>;
        };
        if (!document.info || !("x-case" in document.info)) {
          throw new Error(`${c.name}: loaded document does not carry info/x-case`);
        }
        image = canonicalImage(document.info["x-case"]);
      } catch (error) {
        if (String(error).includes("does not carry info/x-case")) throw error;
        image = "source-refused";
      }
      expect(image).toBe(c.outcome === "source-refused" ? "source-refused" : c.image);
    });
  }
});

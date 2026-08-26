import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { OpenAPISynthesizer } from "./test-helpers.js";

/**
 * The style-lane composite-member case table is SHARED, byte-for-byte, with
 * three other engines: `openbindings-go/formats/openapi`, `openapi-client/go`
 * and `openapi-client/typescript`. Each cell pins the ADMISSION decision all
 * four must reach for one style-lane declaration, so a divergence in any one
 * of them fails the others' suites.
 *
 * This engine executes the cells through the SHIPPED synthesizer: a refused
 * parameter cell must leave no operation behind and must carry a target
 * coverage entry excluded under `openapi.parameter_style_expansion_excluded`,
 * and a refused body cell must leave the operation standing with its
 * request-media alternative excluded. The two `openapi-client` engines execute
 * the same cells through the shipped admission predicates and additionally
 * assert the member each names.
 *
 * Authority: `styleLaneUndefinedExpansionMember` in the client's `media.ts`
 * reads the style table per edition. Package:
 * `design/openapi-style-lane-composite-member-ruling.md`, RULED 2026-08-18.
 */
const CASES_DIGEST = "d23c8fe527971c620627307ba16e220aaab2e25a731488fe62a184a465fb2cb5";

interface StyleLaneCase {
  readonly name: string;
  readonly openapi: string;
  readonly position: "parameter" | "body";
  readonly in?: string;
  readonly style?: string;
  readonly explode?: boolean;
  readonly media?: string;
  readonly encoding: Record<string, unknown> | null;
  readonly schema: Record<string, unknown> | null;
  readonly expect: "admitted" | "refused";
  readonly member: string | null;
  readonly basis: string;
}

const raw = readFileSync(new URL("./testdata/style-lane-composite-member-cases.json", import.meta.url));
const digest = createHash("sha256").update(raw).digest("hex");
const table = JSON.parse(raw.toString("utf8")) as { cases: readonly StyleLaneCase[] };

/**
 * Renders one cell as a WHOLE OpenAPI document, byte-corresponding with the
 * twin engines' renderer.
 */
function document(c: StyleLaneCase): Record<string, unknown> {
  let paths: Record<string, unknown>;
  if (c.position === "parameter") {
    const parameter: Record<string, unknown> = { name: "filter", in: c.in };
    if (c.style !== undefined) parameter["style"] = c.style;
    if (c.explode !== undefined) parameter["explode"] = c.explode;
    if (c.schema !== null) parameter["schema"] = c.schema;
    else {
      parameter["content"] = {
        "application/json": { schema: { type: "object", properties: { where: { type: "object" } } } },
      };
    }
    let template = "/q";
    if (c.in === "path") {
      template = "/q/{filter}";
      parameter["required"] = true;
    }
    paths = {
      [template]: {
        get: { operationId: "query", parameters: [parameter], responses: { "200": { description: "ok" } } },
      },
    };
  } else {
    const media: Record<string, unknown> = {
      schema: { type: "object", properties: { field: c.schema } },
    };
    if (c.encoding !== null) media["encoding"] = { field: c.encoding };
    paths = {
      "/form": {
        post: {
          operationId: "postForm",
          // The body stays OPTIONAL so a refused candidate excludes the
          // alternative rather than the whole target: the alternative is the
          // unit this cell is about.
          requestBody: { content: { [c.media!]: media } },
          responses: { "200": { description: "ok" } },
        },
      },
    };
  }
  return {
    openapi: c.openapi,
    info: { title: "style lane composite member case table", version: "1.0.0" },
    servers: [{ url: "https://api.example.test" }],
    paths,
  };
}

describe("style-lane composite-member case table (shared with three twin engines)", () => {
  it("is byte-identical to the copies the twin engines execute", () => {
    expect(digest).toBe(CASES_DIGEST);
    expect(table.cases.some((c) => c.position === "parameter")).toBe(true);
    expect(table.cases.some((c) => c.position === "body")).toBe(true);
    expect(table.cases.some((c) => c.expect === "refused")).toBe(true);
  });

  for (const testCase of table.cases) {
    it(testCase.name, async () => {
      const result = await new OpenAPISynthesizer().synthesizeInterfaceWithCoverage({
        sources: [{ bindingSpec: "openbindings.openapi-3.1@1", content: JSON.stringify(document(testCase)) }],
      });

      if (testCase.position === "parameter") {
        const entry = result.coverage.entries.find((e) => e.scope === "target");
        expect(entry, "no target coverage entry emitted").toBeDefined();
        if (testCase.expect === "admitted") {
          expect(Object.keys(result.interface.operations)).toContain("query");
          expect(entry!.status).toBe("represented");
        } else {
          expect(Object.keys(result.interface.operations)).not.toContain("query");
          expect(entry!.status).toBe("excluded");
          expect(entry!.reasonCode).toBe("openapi.parameter_style_expansion_excluded");
          expect(entry!.rule).toBe(testCase.openapi.startsWith("3.0.") ? "OAPI30-P-02" : "OAPI31-P-02");
        }
        return;
      }

      const entry = result.coverage.entries.find((e) => e.scope === "alternative");
      expect(entry, "no request-media alternative coverage entry emitted").toBeDefined();
      if (testCase.expect === "admitted") {
        expect(entry!.status).toBe("represented");
      } else {
        expect(entry!.status).toBe("excluded");
        expect(entry!.reasonCode).toBe("openapi.request_media_excluded");
      }
    });
  }
});

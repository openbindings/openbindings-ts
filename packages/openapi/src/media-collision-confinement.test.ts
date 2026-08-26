// The §9.2 normalized-collision CONFINEMENT case table, shared
// byte-identically with the two client engines and the Go adapter
// (testdata/media-collision-confinement-cases.json).
//
// Two keys in ONE content map that denote the same parsed media type are a
// normalized collision, and the defect confines to that colliding parsed
// identity -- the smallest unit that owns it. Here the REQUEST cells run
// through this package's shipped path, synthesis and its coverage ledger: a
// colliding key is an accounted `excluded` alternative naming the identity it
// collides on, while its non-colliding siblings stay `represented` and the
// target survives. The RESPONSE cells run the re-exported client engine out
// of the BUILT dist, which is what this package ships.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OpenAPISynthesizer } from "./test-helpers.js";
import { governingResponseMedia, successMediaTypes } from "./media.js";

interface MediaCollisionCase {
  name: string;
  openapi: string;
  side: "request" | "response";
  description: string;
  content: Record<string, unknown>;
  select: string;
  responseBody?: string;
  outcome: "usable" | "refused";
  output?: unknown;
  advertised?: string[];
  target?: "represented" | "excluded";
  targetReasonCode?: string;
  targetRule?: string;
  represented?: string[];
  excluded?: string[];
  collidingIdentity?: string;
}

const table = JSON.parse(readFileSync(
  new URL("../testdata/media-collision-confinement-cases.json", import.meta.url),
  "utf8",
)) as { cases: MediaCollisionCase[] };

const TARGET_REF = "#/paths/~1items/post";

function escapePointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

function requestDocument(fixture: MediaCollisionCase): Record<string, unknown> {
  return {
    openapi: fixture.openapi,
    info: { title: "media collision confinement", version: "1" },
    servers: [{ url: "https://api.example.test" }],
    paths: {
      "/items": {
        post: {
          operationId: "createItem",
          requestBody: { required: true, content: fixture.content },
          responses: { "204": { description: "stored" } },
        },
      },
    },
  };
}

async function assertRequestCell(fixture: MediaCollisionCase): Promise<void> {
  const result = await new OpenAPISynthesizer().synthesizeInterfaceWithCoverage({
    sources: [{ bindingSpec: "openbindings.openapi-3.1@1", content: JSON.stringify(requestDocument(fixture)) }],
  });
  const target = result.coverage.entries.find((entry) => entry.scope === "target");
  expect(target, "no target coverage entry emitted").toBeDefined();
  const alternatives = new Map(
    result.coverage.entries
      .filter((entry) => entry.scope === "alternative")
      .map((entry) => [entry.sourceRef.replace(`${TARGET_REF}/requestBody/content/`, ""), entry]),
  );

  const operationPresent = Object.keys(result.interface.operations).includes("createItem");
  if (fixture.target === "represented") {
    expect(operationPresent, `operation absent; coverage says ${target!.status} / ${target!.reasonCode}`).toBe(true);
    expect(target!.status).toBe("represented");
  } else {
    expect(operationPresent, "operation present, want the target excluded").toBe(false);
    expect(target!.status).toBe("excluded");
    expect(target!.reasonCode).toBe(fixture.targetReasonCode);
    const targetRule = fixture.targetRule === "OAPI-P-04"
      ? fixture.openapi.startsWith("3.0.") ? "OAPI30-P-03" : "OAPI31-P-03"
      : fixture.targetRule;
    expect(target!.rule).toBe(targetRule);
  }

  const represented = fixture.represented ?? [];
  const excluded = fixture.excluded ?? [];
  expect(alternatives.size).toBe(represented.length + excluded.length);
  for (const mediaKey of represented) {
    const entry = alternatives.get(escapePointerToken(mediaKey));
    expect(entry, `no alternative entry for ${mediaKey}`).toBeDefined();
    expect(entry!.status).toBe("represented");
  }
  for (const mediaKey of excluded) {
    const entry = alternatives.get(escapePointerToken(mediaKey));
    expect(entry, `no alternative entry for ${mediaKey}`).toBeDefined();
    expect(entry!.status).toBe("excluded");
    // The reason vocabulary is unchanged by confinement: a colliding
    // alternative is the family-specific media exclusion, never the
    // parameter-boundary flattening collision.
    expect(entry!.reasonCode).toBe("openapi.request_media_excluded");
    expect(entry!.rule).toBe(fixture.openapi.startsWith("3.0.") ? "OAPI30-P-03" : "OAPI31-P-03");
    expect(entry!.message, "the exclusion must name the colliding identity")
      .toContain(fixture.collidingIdentity);
  }
}

function assertResponseCell(fixture: MediaCollisionCase): void {
  const response = { content: fixture.content as Record<string, Record<string, never>> };
  if (fixture.outcome === "usable") {
    expect(governingResponseMedia(response, fixture.select, true, true)).toBeTruthy();
  } else {
    expect(() => governingResponseMedia(response, fixture.select, true, true)).toThrow();
  }
  const op = { responses: { "200": response } };
  expect(successMediaTypes(op, true, true)).toEqual(fixture.advertised ?? []);
}

describe("language-neutral §9.2 normalized-collision confinement", () => {
  const shape = { request: 0, response: 0, confined: 0, allColliding: 0, control: 0 };
  expect(table.cases.length).toBeGreaterThan(0);
  for (const fixture of table.cases) {
    shape[fixture.side] += 1;
    if (!fixture.collidingIdentity && (fixture.advertised ?? []).length === Object.keys(fixture.content).length) {
      shape.control += 1;
    } else if ((fixture.represented ?? []).length === 0 && (fixture.advertised ?? []).length === 0) {
      shape.allColliding += 1;
    } else {
      shape.confined += 1;
    }
    it(fixture.name, async () => {
      if (fixture.side === "request") {
        await assertRequestCell(fixture);
        return;
      }
      assertResponseCell(fixture);
    });
  }
  // The table's own shape, asserted rather than described: a later editor who
  // deletes one of the four shapes has to notice.
  it("carries every shape the rule needs", () => {
    for (const [name, count] of Object.entries(shape)) {
      expect(count, `case table has no ${name} cells`).toBeGreaterThan(0);
    }
  });
});

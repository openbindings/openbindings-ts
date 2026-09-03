import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildMultipartBody,
  buildURLEncodedBody,
  loadOpenAPIDocument,
  OPENAPI_PROFILE_FULL,
  planRequestBodies,
  plansRequirePropertyMedia,
} from "./media.js";
import type { OpenAPIDocument, OpenAPIMediaType, OpenAPIOperation } from "./types.js";

// The shared case table, executed here against the BUILT
// `@openbindings/openapi-client` dist that this package re-exports — not
// against that package's `src`. The distinction is the point: a `src` edit is
// invisible to this package until the client is rebuilt, so this file is what
// proves the shipped re-export carries the same decisions as the two Go
// engines. The file is byte-identical to the copies in
// openbindings-go/formats/openapi/testdata, openapi-client/go/testdata and
// openapi-client/typescript/src/testdata.
export const PART_DEFAULT_TYPE_ABSENT_CASES_DIGEST =
  "c6494b3b833f03d13e1e7e5cb83547f484b0e20f8f77b70f5f893075eb04e46c";

export interface PartDefaultTypeAbsentCase {
  name: string;
  openapi: string;
  media: string;
  lane: string;
  kind: string;
  declaresType: boolean;
  propertyName: string;
  propertySchema: unknown;
  value: unknown;
  expect: string;
  basis: string;
}

export function loadPartDefaultTypeAbsentCases(raw: Buffer): PartDefaultTypeAbsentCase[] {
  const digest = createHash("sha256").update(raw).digest("hex");
  if (digest !== PART_DEFAULT_TYPE_ABSENT_CASES_DIGEST) {
    throw new Error(
      `case table digest = ${digest}, want ${PART_DEFAULT_TYPE_ABSENT_CASES_DIGEST} (the table is shared byte-for-byte with the twin engines)`,
    );
  }
  const table = JSON.parse(raw.toString("utf8")) as { cases: PartDefaultTypeAbsentCase[] };
  if (table.cases.length === 0) throw new Error("case table is empty");
  return table.cases;
}

/**
 * Render one case as a WHOLE OpenAPI document. The document, and not a
 * hand-built media object, is what the engine has to be given: the shipped
 * loader normalizes the raw tree — boolean-literal schemas among other things
 * — before anything downstream sees it, and a harness that hands `media.ts` a
 * literal object measures an engine the project does not ship.
 */
function documentFor(c: PartDefaultTypeAbsentCase): Record<string, unknown> {
  return {
    openapi: c.openapi,
    info: { title: "type-absent part default case table", version: "1.0.0" },
    paths: {
      "/form": {
        post: {
          operationId: "postForm",
          requestBody: {
            required: true,
            content: {
              [c.media]: {
                schema: { type: "object", properties: { [c.propertyName]: c.propertySchema } },
              },
            },
          },
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

async function emission(
  c: PartDefaultTypeAbsentCase,
  doc: OpenAPIDocument,
  media: OpenAPIMediaType,
): Promise<string> {
  const fields = { [c.propertyName]: c.value };
  try {
    if (c.media === "application/x-www-form-urlencoded") {
      const encoded = buildURLEncodedBody(media, fields, true, c.openapi, false);
      return encoded === "" ? "elided" : encoded;
    }
    const form = buildMultipartBody(doc, media, fields, true, false);
    const rendered: string[] = [];
    for (const entry of form.getAll(c.propertyName)) {
      if (typeof entry === "string") {
        // A bare FormData string field emits a part with NO Content-Type
        // header, which [RFC7578] Section 4.4 makes the same wire fact as an
        // explicit text/plain. The Go twins emit the header; both spellings
        // are inside the permitted set, so the rendering normalizes them
        // together, exactly as the array-items table does.
        rendered.push(`text/plain:${entry}`);
      } else {
        rendered.push(`${entry.type}:${await entry.text()}`);
      }
    }
    return rendered.length === 0 ? "elided" : rendered.join("&");
  } catch {
    return "error";
  }
}

// Refusal messages are each implementation's own surface, so only the decision
// itself crosses the twin boundary.
export async function partDefaultTypeAbsentDecision(c: PartDefaultTypeAbsentCase): Promise<string> {
  let doc: OpenAPIDocument;
  try {
    doc = await loadOpenAPIDocument(undefined, documentFor(c), { allowExternalRefs: false });
  } catch {
    return "source-refused";
  }
  const op = (doc as unknown as Record<string, any>).paths?.["/form"]?.post as OpenAPIOperation | undefined;
  if (!op) throw new Error(`${c.name}: loaded document has no form operation`);
  try {
    const plans = planRequestBodies(op, { profile: OPENAPI_PROFILE_FULL, openapiVersion: c.openapi });
    if (plansRequirePropertyMedia(plans)) return "missing-required-choice";
  } catch {
    return "refused";
  }
  const media = (op.requestBody as any)?.content?.[c.media] as OpenAPIMediaType | undefined;
  if (!media) throw new Error(`${c.name}: loaded document has no ${c.media} media type`);
  return `admitted;emit=${await emission(c, doc, media)}`;
}

/**
 * Pins the corrected family split independently of the table expectations:
 * 3.0 reaches the required propertyMedia choice, while 3.1 admits typeless
 * parts through the canonical-Base64 raw-octet boundary.
 */
export async function assertCorrectedTypeAbsentPartSplit(
  cases: PartDefaultTypeAbsentCase[],
): Promise<number> {
  // EXECUTED, not read off the table's own expectations: the claim is about
  // the engine, so a revert of the implementation has to turn this red too.
  let checked = 0;
  for (const c of cases) {
    const got = await partDefaultTypeAbsentDecision(c);
    const correct = c.declaresType
      ? got.startsWith("admitted;")
      : c.media === "application/x-www-form-urlencoded"
        ? got === "refused"
        : c.openapi.startsWith("3.0")
          ? c.kind === "boolean-literal-true"
            ? got === "refused"
            : got === "missing-required-choice"
          : got.startsWith("admitted;");
    if (!correct) {
      throw new Error(
        `${c.name}: corrected type-absent split failed (decision ${JSON.stringify(got)})\nbasis: ${c.basis}`,
      );
    }
    checked += 1;
  }
  return checked;
}

describe("type-absent part default case table", () => {
  const cases = loadPartDefaultTypeAbsentCases(
    readFileSync(new URL("../testdata/part-default-type-absent-cases.json", import.meta.url)),
  );

  it("has the 128 shared cells", () => {
    expect(cases).toHaveLength(128);
  });

  for (const c of cases) {
    it(`${c.name} -> ${c.expect}`, async () => {
      const got = await partDefaultTypeAbsentDecision(c);
      expect(got, c.basis).toBe(c.expect);
    });
  }

  it("pins the corrected type-absent family split", async () => {
    expect(await assertCorrectedTypeAbsentPartSplit(cases)).toBe(128);
  });
});

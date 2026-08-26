import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildURLEncodedBody,
  loadOpenAPIDocument,
  OPENAPI_PROFILE_FULL,
  planRequestBodies,
} from "./media.js";
import type { OpenAPIDocument, OpenAPIMediaType, OpenAPIOperation } from "./types.js";

// The shared 80-cell case table, executed here against the BUILT
// `@openbindings/openapi-client` dist that this package re-exports — not
// against that package's `src`. The distinction is the point: a `src` edit is
// invisible to this package until the client is rebuilt, so this file is what
// proves the shipped re-export carries the same decisions as the two Go
// engines. The file is byte-identical to the copies in
// openbindings-go/formats/openapi/testdata, openapi-client/go/testdata and
// openapi-client/typescript/src/testdata.
const CASES_DIGEST = "ca17623d67205f5c85424e58295400571394c8e095850c13d7ada68eb72a0fa8";

interface ContentPathCase {
  name: string;
  openapi: string;
  shape: string;
  path: string;
  propertySchema: Record<string, unknown>;
  encoding: Record<string, unknown> | null;
  value: unknown;
  expect: string;
  basis: string;
}

function loadCases(): ContentPathCase[] {
  const raw = readFileSync(new URL("../testdata/urlencoded-content-path-cases.json", import.meta.url));
  const digest = createHash("sha256").update(raw).digest("hex");
  if (digest !== CASES_DIGEST) {
    throw new Error(
      `case table digest = ${digest}, want ${CASES_DIGEST} (the table is shared byte-for-byte with the twin engines)`,
    );
  }
  const table = JSON.parse(raw.toString("utf8")) as { cases: ContentPathCase[] };
  if (table.cases.length !== 80) throw new Error(`case table has ${table.cases.length} cases, want 80`);
  return table.cases;
}

function documentFor(c: ContentPathCase): Record<string, unknown> {
  const media: Record<string, unknown> = {
    schema: { type: "object", properties: { p: c.propertySchema } },
  };
  if (c.encoding !== null) media["encoding"] = { p: c.encoding };
  return {
    openapi: c.openapi,
    info: { title: "urlencoded content path case table", version: "1.0.0" },
    paths: {
      "/form": {
        post: {
          operationId: "postForm",
          requestBody: { required: true, content: { "application/x-www-form-urlencoded": media } },
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

// Refusal messages are each implementation's own surface, so only the decision
// itself crosses the twin boundary.
async function decision(c: ContentPathCase): Promise<string> {
  let doc: OpenAPIDocument;
  try {
    doc = await loadOpenAPIDocument(undefined, documentFor(c), { allowExternalRefs: false });
  } catch {
    return "source-refused";
  }
  const op = (doc as unknown as Record<string, any>).paths?.["/form"]?.post as OpenAPIOperation | undefined;
  if (!op) throw new Error(`${c.name}: loaded document has no form operation`);
  try {
    planRequestBodies(op, { profile: OPENAPI_PROFILE_FULL, openapiVersion: c.openapi });
  } catch {
    return "refused";
  }
  const media = (op.requestBody as any)?.content?.["application/x-www-form-urlencoded"] as
    | OpenAPIMediaType
    | undefined;
  if (!media) throw new Error(`${c.name}: loaded document has no urlencoded media type`);
  let encoded: string;
  try {
    encoded = buildURLEncodedBody(media, { p: c.value }, true, c.openapi, false);
  } catch {
    return "error";
  }
  return `admitted;emit=${encoded === "" ? "elided" : encoded}`;
}

describe("urlencoded content path — the shared table through the built client", () => {
  const cases = loadCases();

  for (const c of cases) {
    it(c.name, async () => {
      const got = await decision(c);
      if (got !== c.expect) {
        throw new Error(`${c.name}: decision = ${got}, want ${c.expect}\nbasis: ${c.basis}`);
      }
    });
  }

  // The deleted legacyOpenAPIFormEncoding predicate stated as an executable
  // claim rather than as an absence in prose: two documents differing ONLY in
  // the patch component of their openapi field emit the same bytes.
  it("emits identical bytes across the patch component of a line", async () => {
    const byLineAndShape = new Map<string, Set<string>>();
    for (const c of cases) {
      const line = c.openapi.slice(0, c.openapi.lastIndexOf("."));
      const key = `${line}|${c.shape}`;
      if (!byLineAndShape.has(key)) byLineAndShape.set(key, new Set());
      byLineAndShape.get(key)!.add(await decision(c));
    }
    expect(byLineAndShape.size).toBe(20);
    for (const [key, decisions] of byLineAndShape) {
      expect(`${key}=${[...decisions].join(" AND ")}`).toBe(`${key}=${[...decisions][0]}`);
    }
  });
});

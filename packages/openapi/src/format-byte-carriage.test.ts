import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildMultipartBody,
  buildRequestBody,
  buildURLEncodedBody,
  loadOpenAPIDocument,
  OPENAPI_PROFILE_FULL,
  planRequestBodies,
} from "./media.js";
import type { BodyPlan, OpenAPIDocument, OpenAPIMediaType, OpenAPIOperation, RoutedInput } from "./types.js";

// The shared `format: byte` carriage case table (stage-3 block 5, escalation
// M4), executed here against the BUILT `@openbindings/openapi-client` dist
// that this package re-exports — not against that package's `src`. The
// distinction is the point: a `src` edit is invisible to this package until
// the client is rebuilt, so this file is what proves the shipped re-export
// carries the same decisions as the two Go engines. The file is
// byte-identical to the copies in openbindings-go/formats/openapi/testdata,
// openapi-client/go/testdata and openapi-client/typescript/src/testdata.
export const FORMAT_BYTE_CARRIAGE_CASES_DIGEST =
  "fd1b8f260712957bd96398cbe48787b56c9d14f51f3cd52d1ea5f33fd0e5c0c0";

export interface FormatByteCarriageCase {
  name: string;
  openapi: string;
  lane: string;
  media: string;
  kind: string;
  propertyName: string;
  schema: Record<string, unknown>;
  value: string;
  encodingContentType?: string;
  expect: string;
  basis: string;
}

export function loadFormatByteCarriageCases(raw: Buffer): FormatByteCarriageCase[] {
  const digest = createHash("sha256").update(raw).digest("hex");
  if (digest !== FORMAT_BYTE_CARRIAGE_CASES_DIGEST) {
    throw new Error(
      `case table digest = ${digest}, want ${FORMAT_BYTE_CARRIAGE_CASES_DIGEST} (the table is shared byte-for-byte with the twin engines)`,
    );
  }
  const table = JSON.parse(raw.toString("utf8")) as { cases: FormatByteCarriageCase[] };
  if (table.cases.length === 0) throw new Error("case table is empty");
  return table.cases;
}

/**
 * Render one case as a WHOLE OpenAPI document. The document, and not a
 * hand-built media object, is what the engine has to be given: the shipped
 * loader normalizes the raw tree before anything downstream sees it.
 */
export function formatByteCarriageDocument(c: FormatByteCarriageCase): Record<string, unknown> {
  const media: Record<string, unknown> = c.lane === "body"
    ? { schema: c.schema }
    : { schema: { type: "object", properties: { [c.propertyName]: c.schema } } };
  if (c.lane !== "body" && c.encodingContentType) {
    media.encoding = { [c.propertyName]: { contentType: c.encodingContentType } };
  }
  return {
    openapi: c.openapi,
    info: { title: "format: byte carriage case table", version: "1.0.0" },
    paths: {
      "/send": {
        post: {
          operationId: "send",
          requestBody: { required: true, content: { [c.media]: media } },
          responses: { "204": { description: "ok" } },
        },
      },
    },
  };
}

function routedBody(value: string): RoutedInput {
  return {
    resolvedPath: "/send",
    queryUnits: [],
    headers: [],
    cookieUnits: [],
    bodyFields: {},
    bodyValue: value,
    bodySet: true,
    populated: { header: new Set(), query: new Set(), cookie: new Set() },
  };
}

async function emission(
  c: FormatByteCarriageCase,
  doc: OpenAPIDocument,
  media: OpenAPIMediaType,
  plan: BodyPlan,
): Promise<string> {
  try {
    if (c.lane === "body") {
      const wire = buildRequestBody(doc, plan, routedBody(c.value));
      const body = wire.body === undefined
        ? ""
        : typeof wire.body === "string"
          ? wire.body
          : await new Blob([wire.body as BlobPart]).text();
      return `${wire.contentType}:${body}`;
    }
    const fields = { [c.propertyName]: c.value };
    if (c.lane === "urlencoded") {
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
        // are inside the permitted set, so the rendering normalizes them.
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
export async function formatByteCarriageDecision(c: FormatByteCarriageCase): Promise<string> {
  let doc: OpenAPIDocument;
  try {
    doc = await loadOpenAPIDocument(undefined, formatByteCarriageDocument(c), { allowExternalRefs: false });
  } catch {
    return "source-refused";
  }
  const op = (doc as unknown as Record<string, any>).paths?.["/send"]?.post as OpenAPIOperation | undefined;
  if (!op) throw new Error(`${c.name}: loaded document has no operation`);
  let plans: BodyPlan[];
  try {
    plans = planRequestBodies(op, { profile: OPENAPI_PROFILE_FULL, openapiVersion: c.openapi });
  } catch {
    return "refused";
  }
  if (plans.length === 0) return "refused";
  const media = (op.requestBody as any)?.content?.[c.media] as OpenAPIMediaType | undefined;
  if (!media) throw new Error(`${c.name}: loaded document has no ${c.media} media type`);
  return `admitted;emit=${await emission(c, doc, media, plans[0]!)}`;
}

/**
 * M4's value half, pinned against its nearest neighbour rather than in
 * isolation: on the 3.0 line `binary` and `byte` take the SAME default part
 * Content-Type and differ only in whether the caller's string is the
 * OpenBindings canonical Base64 boundary. A regression that decoded a `byte`
 * value would leave every content type intact.
 */
export function assertByteCellsAreNotBoundaryDecoded(cases: FormatByteCarriageCase[]): number {
  let seen = 0;
  for (const c of cases) {
    if (!c.openapi.startsWith("3.0") || c.kind !== "byte" || c.lane === "urlencoded") continue;
    seen += 1;
    if (!c.expect.endsWith(`:${c.value}`)) {
      throw new Error(
        `${c.name} expects ${c.expect}, which does not end in the artifact-encoded value ${c.value}`,
      );
    }
  }
  return seen;
}

describe("`format: byte` carriage case table", () => {
  const cases = loadFormatByteCarriageCases(
    readFileSync(new URL("./testdata/format-byte-carriage-cases.json", import.meta.url)),
  );

  it("has the 88 shared cells", () => {
    expect(cases).toHaveLength(88);
  });

  for (const c of cases) {
    it(`${c.name} -> ${c.expect}`, async () => {
      const got = await formatByteCarriageDecision(c);
      expect(got, c.basis).toBe(c.expect);
    });
  }

  it("carries the 3.0 byte value without an OpenBindings boundary decode", () => {
    expect(assertByteCellsAreNotBoundaryDecoded(cases)).toBe(10);
  });
});

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import { buildMultipartBody, buildURLEncodedBody, planRequestBodies } from "./media.js";
import { BINDING_SPEC, profileForBindingSpec } from "./constants.js";
import type { OpenAPIDocument, OpenAPIMediaType, OpenAPIOperation } from "./types.js";

// The shared part-content-encoding case table, executed here against the
// BUILT `@openbindings/openapi-client` dist that this package re-exports —
// not against that package's `src`. The distinction is the point: a `src`
// edit is invisible to this package until the client is rebuilt, so this file
// is what proves the shipped re-export carries the same decisions as the two
// Go engines.
//
// The file is byte-identical to the copies in
// openbindings-go/formats/openapi/testdata, openapi-client/go/testdata and
// openapi-client/typescript/src/testdata.
const partContentEncodingCasesDigest = "06647fe967dbc2d7f6739fa718b79c1f7bb45bcc8ccc7faf4113836fb469b605";

interface PartContentEncodingCase {
  name: string;
  openapi: string;
  media: string;
  part: string;
  contentEncoding: boolean;
  propertySchema: Record<string, unknown>;
  encodingContentType: string | null;
  propertyName: string;
  value: unknown;
  expect: string;
  basis: string;
}

function loadCases(): PartContentEncodingCase[] {
  const path = fileURLToPath(new URL("./testdata/part-content-encoding-cases.json", import.meta.url));
  const raw = readFileSync(path);
  const digest = createHash("sha256").update(raw).digest("hex");
  if (digest !== partContentEncodingCasesDigest) {
    throw new Error(
      `case table digest = ${digest}, want ${partContentEncodingCasesDigest} (the table is shared byte-for-byte with the three twin engines)`,
    );
  }
  const table = JSON.parse(raw.toString("utf8")) as { cases: PartContentEncodingCase[] };
  if (table.cases.length === 0) throw new Error("case table is empty");
  return table.cases;
}

function bodyMedia(c: PartContentEncodingCase): OpenAPIMediaType {
  const media: Record<string, unknown> = {
    schema: { type: "object", properties: { [c.propertyName]: c.propertySchema } },
  };
  if (c.encodingContentType !== null) {
    media.encoding = { [c.propertyName]: { contentType: c.encodingContentType } };
  }
  return media as OpenAPIMediaType;
}

function operation(c: PartContentEncodingCase): OpenAPIOperation {
  return { requestBody: { required: true, content: { [c.media]: bodyMedia(c) } } } as OpenAPIOperation;
}

async function emission(c: PartContentEncodingCase): Promise<string> {
  const doc = { openapi: c.openapi } as OpenAPIDocument;
  const fields = { [c.propertyName]: c.value };
  try {
    if (c.media === "application/x-www-form-urlencoded") {
      const encoded = buildURLEncodedBody(bodyMedia(c), fields, true, c.openapi, false);
      return encoded === "" ? "elided" : encoded;
    }
    const form = buildMultipartBody(doc, bodyMedia(c), fields, true, false);
    const rendered: string[] = [];
    for (const entry of form.getAll(c.propertyName)) {
      if (typeof entry === "string") rendered.push(`text/plain:${entry}`);
      else rendered.push(`${entry.type}:${await entry.text()}`);
    }
    return rendered.length === 0 ? "elided" : rendered.join("&");
  } catch {
    return "error";
  }
}

async function decision(c: PartContentEncodingCase): Promise<string> {
  try {
    planRequestBodies(operation(c), {
      profile: profileForBindingSpec(BINDING_SPEC),
      openapiVersion: c.openapi,
    });
  } catch {
    return "refused";
  }
  return `admitted;emit=${await emission(c)}`;
}

describe("part content encoding — the shared case table, against the built client dist", () => {
  const cases = loadCases();

  for (const c of cases) {
    it(c.name, async () => {
      const got = await decision(c);
      if (got !== c.expect) {
        throw new Error(`${c.name}: decision = ${got}, want ${c.expect}\nbasis: ${c.basis}`);
      }
    });
  }
});

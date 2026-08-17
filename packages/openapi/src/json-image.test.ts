import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildRequestBody,
  loadOpenAPIDocument,
  OPENAPI_PROFILE_FULL,
  OPENAPI_PROFILE_ROUTED,
  planRequestBodies,
} from "./media.js";
import { routeInput } from "./params.js";
import { planAbstractInputRoutes } from "./input-routes-v2.js";
import type { OpenAPIDocument, OpenAPIOperation, OpenAPIParameter } from "./types.js";

// The shared case table, executed here against the BUILT
// `@openbindings/openapi-client` dist that this package re-exports — not
// against that package's `src`. The distinction is the point: a `src` edit is
// invisible to this package until the client is rebuilt, so this file is what
// proves the shipped re-export carries the same JSON image as the two Go
// engines. The file is byte-identical to the copies in
// openbindings-go/formats/openapi/testdata, openapi-client/go/testdata and
// openapi-client/typescript/src/testdata.
export const JSON_IMAGE_CASES_DIGEST =
  "4ada3f3817f9a3f6114ab4aef073bffd405027b568149f3c96e3374f3b8ef27c";

export interface JSONImageCase {
  name: string;
  openapi: string;
  lane: string;
  media: string;
  cell: string;
  formsJSONImage: boolean;
  document: Record<string, unknown>;
  input: Record<string, unknown>;
  expect: string;
  basis: string;
}

export function loadJSONImageCases(raw: Buffer): JSONImageCase[] {
  const digest = createHash("sha256").update(raw).digest("hex");
  if (digest !== JSON_IMAGE_CASES_DIGEST) {
    throw new Error(
      `case table digest = ${digest}, want ${JSON_IMAGE_CASES_DIGEST} (the table is shared byte-for-byte with the twin engines)`,
    );
  }
  const table = JSON.parse(raw.toString("utf8")) as { cases: JSONImageCase[] };
  if (table.cases.length === 0) throw new Error("case table is empty");
  return table.cases;
}

/**
 * Run one cell through the shipped path: the case's WHOLE document is loaded
 * by the re-exported loader, the request bodies are planned, the flat input is
 * routed, and the wire body (or, for the parameter lane, the wire header) is
 * rendered.
 */
export async function jsonImageEmission(c: JSONImageCase): Promise<string> {
  const doc: OpenAPIDocument = await loadOpenAPIDocument(undefined, c.document, {
    allowExternalRefs: false,
  });
  const op = (doc as unknown as Record<string, any>).paths?.["/probe"]?.post as
    | OpenAPIOperation
    | undefined;
  if (!op) throw new Error(`${c.name}: loaded document has no probe operation`);
  const parameters = ((op as unknown as Record<string, unknown>).parameters ?? []) as OpenAPIParameter[];

  if (c.lane === "parameter-content") {
    const routed = routeInput(parameters, c.input, "/probe", null, OPENAPI_PROFILE_FULL);
    return routed.headers
      .map(([name, value]: [string, string]) => `${name}: ${value}`)
      .sort()
      .join("\n");
  }

  const plans = planRequestBodies(op, {
    profile: OPENAPI_PROFILE_FULL,
    openapiVersion: c.openapi,
  });
  const plan = plans.find((candidate: { mediaType: string }) => candidate.mediaType === c.media);
  if (!plan) throw new Error(`${c.name}: no request plan for ${c.media}`);
  const routed = routeInput(parameters, c.input, "/probe", plan, OPENAPI_PROFILE_FULL);
  const wire = buildRequestBody(doc, plan, routed);
  if (wire.body === undefined) throw new Error(`${c.name}: no body emitted`);
  if (c.lane !== "multipart-part") return String(wire.body);

  const form = wire.body as FormData;
  const rendered: string[] = [];
  for (const entry of form.getAll("address")) {
    if (typeof entry === "string") {
      // A bare FormData string field emits a part with NO Content-Type header,
      // which RFC 7578 §4.4 makes the same wire fact as an explicit
      // text/plain. The Go twins emit the header; the rendering normalizes
      // them together, exactly as the sibling tables do.
      rendered.push(`text/plain:${entry}`);
    } else {
      rendered.push(`${entry.type}:${await entry.text()}`);
    }
  }
  return rendered.join("&");
}

describe("JSON image case table (shipped dist)", () => {
  const cases = loadJSONImageCases(
    readFileSync(new URL("./testdata/json-image-cases.json", import.meta.url)),
  );

  it("has the 42 shared cells", () => {
    expect(cases).toHaveLength(42);
  });

  for (const c of cases) {
    it(`${c.name}`, async () => {
      expect(await jsonImageEmission(c), c.basis).toBe(c.expect);
    });
  }

  it("leaves the urlencoded style lane untouched", async () => {
    let checked = 0;
    for (const c of cases) {
      if (c.formsJSONImage) continue;
      for (const forbidden of ["%7B", "%22", "+"]) {
        expect(c.expect, `${c.name} carries ${forbidden}`).not.toContain(forbidden);
      }
      // EXECUTED, not read off the table: the claim is about the engine.
      expect(await jsonImageEmission(c), c.name).toBe(c.expect);
      checked += 1;
    }
    expect(checked).toBe(6);
  });

  // The fifth emission site, which is not a wire lane: the revision-2 routing
  // transform expression this package's synthesizer writes into an emitted
  // OBI's `inputTransform`.
  it("carries literal characters through the routing transform expression", () => {
    const parameters = [{ name: "a&b<c>d", in: "query" }] as unknown as OpenAPIParameter[];
    const routes = planAbstractInputRoutes(parameters, [], OPENAPI_PROFILE_ROUTED);
    const expression = routes.transformExpression();
    for (const escape of ["\\u0026", "\\u003c", "\\u003e"]) {
      expect(expression, `routing transform carries ${escape}`).not.toContain(escape);
    }
    expect(expression).toContain("a&b<c>d");
  });
});

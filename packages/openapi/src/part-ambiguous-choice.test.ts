import { describe, expect, it } from "vitest";
import { ERR_REFUSED } from "@openbindings/invoke";
// The production invoker, not the test helper: the helper re-keys every
// source to the 3.0/3.1 tokens and cannot load a 3.2 document.
import { OpenAPIInvoker } from "./invoker.js";

// An authored `anyOf: [{}, {not: {}}]` at a form property or multipart part
// is a choice with two candidates under Section 5.2 of the 3.x binding
// specifications: a choice skips only a branch whose resolved declaration
// declares only `null`, `not` never participates in resolution (so
// `{not: {}}` is typeless and a candidate beside `{}`), and the choice
// supplies a single resolved member declaration only when exactly one
// candidate remains. No single member means no Section 9.3 Encoding default
// row and no part carriage, so a supplied value refuses before dispatch as
// the plain species, exactly as `oneOf: [{type: string}, {type: integer}]`
// does. Until 2026-09-02 the client engine read the structure as a literal
// `true` in one reader and as ambiguous in another; on the 3.2 urlencoded
// lane the first reading won through this adapter and the member was
// DISPATCHED as a typeless field. Every cell here runs through the shipped
// SDK path: OpenAPIInvoker over the openapi-client dist.

const AMBIGUOUS = { anyOf: [{}, { not: {} }] };
const BASE = "https://api.example.test";

function documentFor(edition: string, media: string, part: unknown): Record<string, unknown> {
  return {
    openapi: edition,
    info: { title: "t", version: "1" },
    servers: [{ url: BASE }],
    paths: {
      "/up": {
        post: {
          requestBody: {
            required: true,
            content: { [media]: { schema: { type: "object", properties: { ok: { type: "string" }, choice: part } } } },
          },
          responses: { "204": { description: "ok" } },
        },
      },
    },
  };
}

interface Captured { method: string; contentType: string; body: string }

async function invoke(edition: string, media: string, part: unknown, value: unknown): Promise<{ captured: Captured[]; code: string | null }> {
  const captured: Captured[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    captured.push({
      method: request.method,
      contentType: request.headers.get("content-type") ?? "",
      body: await request.text(),
    });
    return new Response(null, { status: 204 });
  };
  const call = new OpenAPIInvoker().invokeBinding({
    source: { bindingSpec: `openbindings.openapi-${edition.slice(0, 3)}@1`, content: documentFor(edition, media, part) },
    selector: "#/paths/~1up/post",
    context: {},
    fetch,
  });
  let code: string | null = null;
  await call.write({ body: { ok: "fine", choice: value } }).catch(() => undefined);
  await call.close();
  try {
    for await (const _output of call.outputs) { /* drain */ }
  } catch (error: unknown) {
    code = (error as { code?: string }).code ?? `unknown: ${String((error as Error).message ?? error)}`;
  }
  return { captured, code };
}

describe("an ambiguous choice member (Section 5.2) through the shipped SDK path", () => {
  for (const edition of ["3.0.4", "3.1.2", "3.2.0"]) {
    for (const media of ["multipart/form-data", "application/x-www-form-urlencoded"]) {
      it(`refuses a supplied value before dispatch on ${edition} ${media}`, async () => {
        const { captured, code } = await invoke(edition, media, AMBIGUOUS, "eA==");
        expect(captured).toHaveLength(0);
        expect(code).toBe(ERR_REFUSED);
      });
    }
  }

  // The literal `true` is the always-true schema: on the 3.1 line a multipart
  // part takes the typeless application/octet-stream default with the
  // canonical Base64 boundary (Section 9.3). This is the cell the Section 5.2
  // reading must not move.
  it("keeps a literal true part on the 3.1 typeless octet lane", async () => {
    const { captured, code } = await invoke("3.1.2", "multipart/form-data", true, "eA==");
    expect(code).toBeNull();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe("POST");
    expect(captured[0]!.contentType).toContain("multipart/form-data");
    expect(captured[0]!.body).toContain("application/octet-stream");
    expect(captured[0]!.body).toContain("\r\n\r\nx\r\n");
  });
});

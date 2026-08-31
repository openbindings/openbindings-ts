import { describe, expect, it } from "vitest";
import { single, ERR_REFUSED, ERR_EXECUTION_FAILED, InvocationError } from "@openbindings/invoke";
import { OpenAPIInvoker, OpenAPISynthesizer } from "./invoker.js";
import { BINDING_SPEC_OPENAPI_30, BINDING_SPEC_OPENAPI_31 } from "./constants.js";

// Adapter-lane regressions for the OpenAPI hostile-pass engine round
// (adjudication 2026-08-29). Every case here is reached through ordinary
// binding invocation or synthesis, not through a directly called helper.

const OK_200 = { description: "ok", content: { "application/json": { schema: { type: "object" } } } };

function recordingFetch(response: () => Response): {
  fetch: typeof globalThis.fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const fetchFn = async (input: RequestInfo | URL): Promise<Response> => {
    urls.push(input instanceof Request ? input.url : String(input));
    return response();
  };
  return { fetch: fetchFn, urls };
}

async function invokeTarget(
  content: unknown,
  bindingSpec: string,
  selector: string,
  input: unknown,
  response: () => Response,
): Promise<{ outcome: string; value?: unknown; dispatches: number }> {
  const { fetch, urls } = recordingFetch(response);
  const call = new OpenAPIInvoker().invokeBinding({
    source: { bindingSpec, content },
    selector,
    fetch,
  });
  if (input !== undefined) await call.write(input);
  else await call.close();
  try {
    const value = await single(call.outputs);
    return { outcome: "complete", value, dispatches: urls.length };
  } catch (error: unknown) {
    return {
      outcome: error instanceof InvocationError ? error.code : `other:${String(error)}`,
      dispatches: urls.length,
    };
  }
}

const jsonPeer = (): Response =>
  new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "application/json" } });

// ---------------------------------------------------------------------------
// Equivalent-hierarchy path keys exclude on 3.0 as well as 3.1 (3.0#8 / P1-B)
// ---------------------------------------------------------------------------

function equivalentTemplateDocument(edition: string): unknown {
  const templated = (operationId: string, name: string): unknown => ({
    get: {
      operationId,
      parameters: [{ name, in: "path", required: true, schema: { type: "string" } }],
      responses: { "200": OK_200 },
    },
  });
  return {
    openapi: edition,
    info: { title: "Equivalent hierarchies", version: "1" },
    servers: [{ url: "https://api.example" }],
    paths: {
      "/pets/{id}": templated("byId", "id"),
      "/pets/{petId}": templated("byPetId", "petId"),
      "/other": { get: { operationId: "other", responses: { "200": OK_200 } } },
    },
  };
}

describe("equivalent-hierarchy path keys are excluded on both 3.x siblings", () => {
  for (const [edition, bindingSpec] of [
    ["3.0.4", BINDING_SPEC_OPENAPI_30],
    ["3.1.2", BINDING_SPEC_OPENAPI_31],
  ] as const) {
    it(`${edition}: a participating target refuses before any caller value is inspected`, async () => {
      const observed = await invokeTarget(
        equivalentTemplateDocument(edition),
        bindingSpec,
        "#/paths/~1pets~1{id}/get",
        { parameters: { id: "7" } },
        jsonPeer,
      );
      expect(observed).toEqual({ outcome: ERR_REFUSED, dispatches: 0 });
    });

    it(`${edition}: a non-conflicting target survives`, async () => {
      const observed = await invokeTarget(
        equivalentTemplateDocument(edition),
        bindingSpec,
        "#/paths/~1other/get",
        undefined,
        jsonPeer,
      );
      expect(observed).toEqual({ outcome: "complete", value: { ok: true }, dispatches: 1 });
    });

    it(`${edition}: synthesis emits only the surviving operation`, async () => {
      const result = await new OpenAPISynthesizer().synthesizeInterfaceWithCoverage({
        sources: [{ name: "s", bindingSpec, content: equivalentTemplateDocument(edition) }],
      });
      const operations = (result as { interface: { operations: Record<string, unknown> } }).interface.operations;
      expect(Object.keys(operations)).toEqual(["other"]);
    });
  }
});

// ---------------------------------------------------------------------------
// Response Object defects confine to the smallest owner (3.1#10 / PS-119)
// ---------------------------------------------------------------------------

const RESPONSE_OWNER_DOCUMENT = {
  openapi: "3.1.2",
  info: { title: "Response owner", version: "1" },
  servers: [{ url: "https://api.example" }],
  paths: {
    // Upstream-invalid: a Response Object's `description` is REQUIRED.
    "/bad": {
      get: {
        operationId: "bad",
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/good": { get: { operationId: "good", responses: { "200": OK_200 } } },
  },
};

describe("an upstream-invalid Response Object excludes only its own target", () => {
  it("the defective target refuses before dispatch", async () => {
    const observed = await invokeTarget(
      RESPONSE_OWNER_DOCUMENT, BINDING_SPEC_OPENAPI_31, "#/paths/~1bad/get", undefined, jsonPeer);
    expect(observed).toEqual({ outcome: ERR_REFUSED, dispatches: 0 });
  });

  it("the sibling operation stays invocable", async () => {
    const observed = await invokeTarget(
      RESPONSE_OWNER_DOCUMENT, BINDING_SPEC_OPENAPI_31, "#/paths/~1good/get", undefined, jsonPeer);
    expect(observed).toEqual({ outcome: "complete", value: { ok: true }, dispatches: 1 });
  });

  it("source inspection lists the survivor and omits the excluded target", async () => {
    const inspection = await new OpenAPISynthesizer().inspectSource({
      name: "s", bindingSpec: BINDING_SPEC_OPENAPI_31, content: RESPONSE_OWNER_DOCUMENT,
    });
    const selectors = (inspection as { targets: { selector: string }[] }).targets.map((t) => t.selector);
    expect(selectors).toEqual(["#/paths/~1good/get"]);
  });
});

// ---------------------------------------------------------------------------
// Response JSON strictness through the adapter (A3b / A3d, P1-G / P1-H)
// ---------------------------------------------------------------------------

const JSON_LANE_DOCUMENT = {
  openapi: "3.1.2",
  info: { title: "JSON lane", version: "1" },
  servers: [{ url: "https://api.example" }],
  paths: {
    "/x": {
      get: { responses: { "200": { description: "ok", content: { "application/json": { schema: {} } } } } },
    },
  },
};

async function readJSON(bytes: Uint8Array): Promise<{ outcome: string; value?: unknown; dispatches: number }> {
  return await invokeTarget(
    JSON_LANE_DOCUMENT, BINDING_SPEC_OPENAPI_31, "#/paths/~1x/get", undefined,
    () => new Response(bytes as unknown as BodyInit, { status: 200, headers: { "Content-Type": "application/json" } }),
  );
}

describe("strict JSON response profile through the adapter", () => {
  it("ignores a leading byte-order mark", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"a":1}')]);
    expect(await readJSON(bytes)).toEqual({ outcome: "complete", value: { a: 1 }, dispatches: 1 });
  });

  it("makes an unpaired surrogate escape a loud protocol error", async () => {
    for (const source of ['{"a":"\\ud800"}', '{"a":"\\udc00"}']) {
      const observed = await readJSON(new TextEncoder().encode(source));
      expect(observed).toEqual({ outcome: ERR_EXECUTION_FAILED, dispatches: 1 });
    }
  });

  it("still decodes a well-formed surrogate pair", async () => {
    const observed = await readJSON(new TextEncoder().encode('{"a":"\\ud83d\\ude00"}'));
    expect(observed).toEqual({ outcome: "complete", value: { a: "\u{1F600}" }, dispatches: 1 });
  });
});

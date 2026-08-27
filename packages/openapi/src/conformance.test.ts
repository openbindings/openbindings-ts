import { describe, it, expect } from "vitest";
import {
  single,
  ERR_INVALID_SELECTOR,
  ERR_PROTOCOL,
  ERR_RESPONSE_ERROR,
  ERR_REFUSED,
} from "@openbindings/invoke";
import { OpenAPIInvoker } from "./test-helpers.js";
import { loadOpenAPIDocument } from "./util.js";

// Integration tests keyed to openbindings.openapi-3.1@1 rules, driving the
// invoker against a captured fetch. Mirrors the Go SDK's
// invoke_conformance_test.go.

// ---------------------------------------------------------------------------
// Fetch mock (invoker.test.ts's convention)
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body?: BodyInit | null;
}

function mockFetch(
  respond: (req: CapturedRequest) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fn = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const req: CapturedRequest = {
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body,
    };
    requests.push(req);
    return respond(req);
  };
  return { fetch: fn, requests };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(chunks: string[], init?: { status?: number }): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: init?.status ?? 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function src(spec: unknown) {
  // Most tests in this file target routing, refs, or credentials rather
  // than response-declaration mismatch. Give their minimal fixtures the
  // JSON declaration their mocked non-empty JSON response requires under
  // OAPI-P-06/P-07; tests with an explicit content map remain untouched.
  const content = structuredClone(spec);
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const object = value as Record<string, unknown>;
    if (
      object.responses &&
      typeof object.responses === "object" &&
      !Array.isArray(object.responses)
    ) {
      for (const response of Object.values(
        object.responses as Record<string, unknown>,
      )) {
        if (
          response &&
          typeof response === "object" &&
          !Array.isArray(response)
        ) {
          const item = response as Record<string, unknown>;
          if (item.content === undefined)
            item.content = { "application/json": {} };
        }
      }
    }
    for (const member of Object.values(object)) visit(member);
  };
  visit(content);
  return { bindingSpec: "openbindings.openapi-3.1@1", content };
}

const BASE = "https://api.example.test";

/** A minimal one-operation spec: GET /session with an optional cookie param. */
const WIDGET_SPEC = {
  openapi: "3.0.3",
  info: { title: "t", version: "1" },
  servers: [{ url: BASE }],
  paths: {
    "/session": {
      get: {
        operationId: "getSession",
        parameters: [
          { name: "session_id", in: "cookie", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": {}, "text/plain": {} },
          },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// OAPI-D-03 — selector shape at the invoke boundary
// ---------------------------------------------------------------------------

describe("OAPI-D-03 — selector shape", () => {
  // An uppercase selector method is non-conformant: refused with
  // ERR_INVALID_SELECTOR, never case-folded to a match.
  it("refuses an uppercase selector method before dispatch", async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker().invokeBinding({
      source: src(WIDGET_SPEC),
      selector: "#/paths/~1session/GET",
      fetch,
    });
    await expect(call.closed).rejects.toMatchObject({ code: ERR_INVALID_SELECTOR });
    expect(requests).toHaveLength(0);
  });

  // A path item that is a $ref (3.1 components.pathItems) resolves before
  // the method segment evaluates (OAPI-D-03: OAS reference resolution, not
  // raw JSON traversal).
  it("resolves a path-item $ref before the method segment", async () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      servers: [{ url: BASE }],
      paths: { "/shared": { $ref: "#/components/pathItems/Shared" } },
      components: {
        pathItems: {
          Shared: {
            get: {
              operationId: "sharedGet",
              responses: { "200": { description: "ok" } },
            },
          },
        },
      },
    };
    const { fetch, requests } = mockFetch(() => jsonResponse({ ok: true }));
    const call = new OpenAPIInvoker().invokeBinding({
      source: src(spec),
      selector: "#/paths/~1shared/get",
      fetch,
    });
    await expect(single(call.outputs)).resolves.toEqual({ ok: true });
    expect(requests[0]?.url).toBe(`${BASE}/shared`);
  });
});

// ---------------------------------------------------------------------------
// OAPI-P-01 / §3 / §6 — accepted editions, duplicate keys, self-containment
// ---------------------------------------------------------------------------

describe("OAPI-P-01 / §3 / §6 — loading", () => {
  it("accepts every exact edition in the frozen envelope", async () => {
    for (const v of [
      "3.0.0",
      "3.0.1",
      "3.0.2",
      "3.0.3",
      "3.0.4",
      "3.1.0",
      "3.1.1",
      "3.1.2",
    ]) {
      const doc = await loadOpenAPIDocument(
        undefined,
        `{"openapi": "${v}", "info": {"title": "t", "version": "1"}, "paths": {}}`,
      );
      expect(doc.openapi).toBe(v);
    }
  });

  it("refuses values outside the frozen envelope rather than inferring line compatibility", async () => {
    const rejected = [
      '{"swagger": "2.0", "info": {"title": "t", "version": "1"}, "paths": {}}',
      ...["3.0.5", "3.1.3", "3.2.0"].map(
        (v) =>
          `{"openapi": "${v}", "info": {"title": "t", "version": "1"}, "paths": {}}`,
      ),
    ];
    for (const content of rejected) {
      await expect(loadOpenAPIDocument(undefined, content)).rejects.toThrow(
        "OAPI-P-01",
      );
    }
  });

  // §3: duplicate mapping keys in string content are refused loudly (the
  // YAML layer enforces this).
  it("refuses duplicate YAML mapping keys loudly", async () => {
    const content =
      "openapi: 3.0.3\ninfo: {title: t, version: '1'}\npaths:\n  /a:\n    get:\n      operationId: one\n      responses: {'200': {description: ok}}\n  /a:\n    post:\n      operationId: two\n      responses: {'200': {description: ok}}\n";
    await expect(loadOpenAPIDocument(undefined, content)).rejects.toThrow();
  });

  // §6: embedded content with no co-present location must be
  // self-contained; a relative external $ref fails with a readable error.
  it("gives a readable self-containment error for a relative $ref with no location", async () => {
    const content = `{"openapi": "3.0.3", "info": {"title": "t", "version": "1"},
      "paths": {"/a": {"get": {"operationId": "x", "responses": {"200": {"description": "ok",
        "content": {"application/json": {"schema": {"$ref": "shared.json#/Thing"}}}}}}}}}`;
    await expect(loadOpenAPIDocument(undefined, content)).rejects.toThrow(
      "self-contained",
    );
  });
});

// ---------------------------------------------------------------------------
// OAPI-P-03 — flattened-model refusals at the invoke boundary
// ---------------------------------------------------------------------------

describe("OAPI-P-03 — flattened-model refusals", () => {
  it("refuses case-folding header collisions before dispatch", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      servers: [{ url: BASE }],
      paths: {
        "/items": {
          get: {
            operationId: "get",
            parameters: [
              { name: "X-ID", in: "header", schema: { type: "string" } },
              { name: "x-id", in: "header", schema: { type: "string" } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker().invokeBinding({
      source: src(spec),
      selector: "#/paths/~1items/get",
      fetch,
    });
    await expect(call.closed).rejects.toMatchObject({
      code: ERR_REFUSED,
    });
    expect(requests).toHaveLength(0);
  });

  // A field matching no declared parameter is refused pre-dispatch when the
  // operation declares no request body — loud, naming the offenders.
  it("refuses unmatched fields loudly when no request body is declared", async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker().invokeBinding({
      source: src(WIDGET_SPEC),
      selector: "#/paths/~1session/get",
      fetch,
    });
    await call.write({ session_id: "s", bogus: 1 });
    await expect(call.closed).rejects.toMatchObject({
      code: ERR_REFUSED,
    });
    expect(requests).toHaveLength(0);
  });

  // §9.1 (OAPI-P-03): with a NON-OBJECT declared request body, the
  // flattened contract carries only parameters and the synthetic `body`
  // property — an input field matching neither has no destination and
  // refuses pre-dispatch, loudly, naming the unroutable field (same species
  // of refusal as the no-body unmatched case above).
  it("refuses an unmatched field loudly for a non-object request body", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        "string JSON body",
        { "application/json": { schema: { type: "string" } } },
      ],
      [
        "array JSON body",
        {
          "application/json": {
            schema: { type: "array", items: { type: "integer" } },
          },
        },
      ],
      [
        "binary-in-JSON body (3.1 contentEncoding)",
        {
          "application/json": {
            schema: { type: "string", contentEncoding: "base64" },
          },
        },
      ],
      ["text/plain body", { "text/plain": { schema: { type: "string" } } }],
      // §9.1's object determination is by declaration alone: a TYPELESS
      // schema — neither `properties` nor an explicit object type — is
      // non-object, so the refusal fires for it exactly as for arrays
      // and scalars.
      [
        "typeless JSON body (bare schema)",
        { "application/json": { schema: {} } },
      ],
      [
        "typeless JSON body (description-only schema)",
        { "application/json": { schema: { description: "opaque payload" } } },
      ],
    ];
    for (const [name, content] of cases) {
      const spec = {
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        servers: [{ url: BASE }],
        paths: {
          "/echo": {
            post: {
              operationId: "echo",
              requestBody: { required: true, content },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      };
      const { fetch, requests } = mockFetch(() => jsonResponse({}));
      const call = new OpenAPIInvoker().invokeBinding({
        source: src(spec),
        selector: "#/paths/~1echo/post",
        fetch,
      });
      await call.write({ body: "x", stray: 1 });
      await expect(call.closed, name).rejects.toMatchObject({
        code: ERR_REFUSED,
      });
      expect(requests, name).toHaveLength(0);
    }
  });

  // §9.1 (OAPI-P-03): a TYPELESS request-body schema — declaring neither
  // `properties` nor an explicit object type; a bare {} or a
  // description-only schema — is non-object by declaration alone, so the
  // flattened contract carries the synthetic `body` property and, at the
  // wire, that property's value IS the request body, unwrapped. The
  // published contract and the invoker share one determination
  // (bodySchemaFlattens): a caller following the contract must never see
  // its value double-wrapped as {"body": X}.
  it("unwraps a typeless request body from the synthetic body property onto the wire", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["bare schema", {}],
      ["description-only schema", { description: "opaque payload" }],
      // A 3.1 two-element type array is not an EXPLICIT object type (only
      // the single-element form is): synthetic, like typeless.
      ["nullable object without properties", { type: ["object", "null"] }],
    ];
    for (const [name, schema] of cases) {
      const spec = {
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        servers: [{ url: BASE }],
        paths: {
          "/echo": {
            post: {
              operationId: "echo",
              requestBody: {
                required: true,
                content: { "application/json": { schema } },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      };
      const { fetch, requests } = mockFetch(() => jsonResponse({}));
      const call = new OpenAPIInvoker().invokeBinding({
        source: src(spec),
        selector: "#/paths/~1echo/post",
        fetch,
      });
      await call.write({ body: { k: "v" } });
      await single(call.outputs);
      expect(requests[0]?.body, name).toBe('{"k":"v"}');
    }
  });

  // §9.1 (OAPI-P-03): the other half of the declaration-only determination
  // — a schema declaring `properties` WITHOUT a type is object by
  // declaration, so it flattens by property name exactly as the
  // synthesized contract publishes it; the fix for the typeless case must
  // not overshoot into wrapping properties-carrying schemas.
  it("keeps flattening a properties-without-type body by name", async () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      servers: [{ url: BASE }],
      paths: {
        "/w": {
          post: {
            operationId: "makeW",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { properties: { name: { type: "string" } } },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker().invokeBinding({
      source: src(spec),
      selector: "#/paths/~1w/post",
      fetch,
    });
    await call.write({ name: "x" });
    await single(call.outputs);
    expect(requests[0]?.body).toBe('{"name":"x"}');
  });

  // §9.1 (OAPI-P-03): with an OBJECT body, a field matching no declared
  // parameter or body property joins the body value BEFORE encoding
  // selection and rides whatever encoding the body rides — JSON here,
  // exactly like declared fields.
  it("joins passthrough fields into a JSON object body", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      servers: [{ url: BASE }],
      paths: {
        "/w": {
          post: {
            operationId: "makeW",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { name: { type: "string" } },
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker().invokeBinding({
      source: src(spec),
      selector: "#/paths/~1w/post",
      fetch,
    });
    await call.write({ name: "x", extra: "y" });
    await single(call.outputs);
    expect(requests[0]?.headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(requests[0]?.body as string)).toEqual({ extra: "y", name: "x" });
  });

  // Unlike JSON, multipart needs declaration-defined part carriage. Unknown
  // members therefore fail closed instead of inheriting an invented codec.
  it("refuses undeclared multipart members with no faithful part carriage", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      servers: [{ url: BASE }],
      paths: {
        "/upload": {
          post: {
            operationId: "upload",
            requestBody: {
              required: true,
              content: {
                "multipart/form-data": {
                  schema: {
                    type: "object",
                    properties: { description: { type: "string" } },
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker().invokeBinding({
      source: src(spec),
      selector: "#/paths/~1upload/post",
      fetch,
    });
    await call.write({ description: "d", note: "urgent", meta: { k: "v" } });
    await expect(call.closed).rejects.toMatchObject({
      code: ERR_REFUSED,
    });
    expect(requests).toHaveLength(0);
  });

  // urlencoded carriage likewise needs a declaration-defined serialization.
  it("refuses undeclared urlencoded members", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      servers: [{ url: BASE }],
      paths: {
        "/form": {
          post: {
            operationId: "postForm",
            requestBody: {
              required: true,
              content: {
                "application/x-www-form-urlencoded": {
                  schema: {
                    type: "object",
                    properties: { name: { type: "string" } },
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker().invokeBinding({
      source: src(spec),
      selector: "#/paths/~1form/post",
      fetch,
    });
    await call.write({ name: "a b", extra: "y" });
    await expect(call.closed).rejects.toMatchObject({
      code: ERR_REFUSED,
    });
    expect(requests).toHaveLength(0);
  });

  // A supplied input missing a declared path parameter always refuses
  // before dispatch (§9.1); other missing required members are the
  // server's business.
  it("refuses a supplied input missing a declared path parameter", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      servers: [{ url: BASE }],
      paths: {
        "/w/{id}": {
          post: {
            operationId: "makeW",
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
            ],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { name: { type: "string" } },
                    required: ["name"],
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const { fetch, requests } = mockFetch(() => jsonResponse({ ok: true }));
    const inv = new OpenAPIInvoker();

    const call = inv.invokeBinding({
      source: src(spec),
      selector: "#/paths/~1w~1{id}/post",
      fetch,
    });
    await call.write({ name: "x" });
    await expect(call.closed).rejects.toMatchObject({
      code: ERR_REFUSED,
    });
    expect(requests).toHaveLength(0);

    // A supplied input missing a required BODY member is sent as-is: with
    // no body fields and a non-required requestBody, the body is omitted.
    const call2 = inv.invokeBinding({
      source: src(spec),
      selector: "#/paths/~1w~1{id}/post",
      fetch,
    });
    await call2.write({ id: "7" });
    await expect(single(call2.outputs)).resolves.toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body == null).toBe(true);
  });

  // Style/explode serialization over the wire: an exploded form array
  // repeats the parameter; deepObject brackets its members (OAPI-P-02).
  it("serializes query styles onto the wire in declaration order", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      servers: [{ url: BASE }],
      paths: {
        "/search": {
          get: {
            operationId: "search",
            parameters: [
              {
                name: "tags",
                in: "query",
                schema: { type: "array", items: { type: "string" } },
              },
              {
                name: "flat",
                in: "query",
                style: "form",
                explode: false,
                schema: { type: "array", items: { type: "string" } },
              },
              {
                name: "filter",
                in: "query",
                style: "deepObject",
                explode: true,
                schema: { type: "object" },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker({ parameterConversion: String }).invokeBinding({
      source: src(spec),
      selector: "#/paths/~1search/get",
      fetch,
    });
    await call.write({
      tags: ["a", "b"],
      flat: ["x", "y"],
      filter: { kind: "big", size: 2 },
    });
    await single(call.outputs);
    // Declaration order: tags (form explode default), flat, filter.
    expect(requests[0]?.url).toBe(
      `${BASE}/search?tags=a&tags=b&flat=x,y&filter[kind]=big&filter[size]=2`,
    );
  });

  // Matrix/label path styles substitute their full expansions into the
  // template (OAPI-P-02).
  it("substitutes matrix path expansions into the template", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      servers: [{ url: BASE }],
      paths: {
        "/map/{coords}": {
          get: {
            operationId: "map",
            parameters: [
              {
                name: "coords",
                in: "path",
                required: true,
                style: "matrix",
                explode: false,
                schema: { type: "array", items: { type: "number" } },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker({ parameterConversion: String }).invokeBinding({
      source: src(spec),
      selector: "#/paths/~1map~1{coords}/get",
      fetch,
    });
    await call.write({ coords: [50.4, 4.32] });
    await single(call.outputs);
    expect(requests[0]?.url).toBe(`${BASE}/map/;coords=50.4,4.32`);
  });
});

// ---------------------------------------------------------------------------
// OAPI-P-04 — media selection and bodies on the wire
// ---------------------------------------------------------------------------

describe("OAPI-P-04 — request media on the wire", () => {
  it("carries an OAS 3.0 binary request as exact Base64-decoded octets", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      servers: [{ url: BASE }],
      paths: {
        "/blob": {
          post: {
            operationId: "putBlob",
            requestBody: {
              required: true,
              content: {
                "application/octet-stream": {
                  schema: { type: "string", format: "binary" },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker().invokeBinding({
      source: { ...src(spec), bindingSpec: "openbindings.openapi-3.1@1" },
      selector: "#/paths/~1blob/post",
      fetch,
    });
    await call.write({ body: "AAEC" });
    await single(call.outputs);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("Content-Type")).toBe("application/octet-stream");
    expect([...new Uint8Array(requests[0]?.body as ArrayBuffer)]).toEqual([0, 1, 2]);
  });

  // §9.2 (OAPI-P-04): a degenerate media/schema combination — selection
  // landing on multipart/form-data or application/x-www-form-urlencoded
  // while the declared body schema does not flatten (§9.1's
  // declaration-only determination: no properties and no explicit object
  // type), or on text/plain while it does — has no OAS-defined wire form
  // and refuses pre-dispatch rather than inventing carriage. Mirrors the
  // Go SDK's TestInvoke_DegenerateMediaSchemaCombinationRefused.
  const degenerateCases: [string, Record<string, unknown>][] = [
    [
      "multipart-only with a scalar schema",
      { "multipart/form-data": { schema: { type: "string" } } },
    ],
    [
      // §9.1's determination is declaration-only: a TYPELESS schema
      // (neither `properties` nor an explicit object type) does not
      // flatten, so the refusal fires for it exactly as for scalars.
      "multipart-only with a typeless schema",
      { "multipart/form-data": { schema: { description: "opaque" } } },
    ],
    [
      "urlencoded-only with a scalar schema",
      { "application/x-www-form-urlencoded": { schema: { type: "integer" } } },
    ],
    [
      "text-only with an object schema",
      {
        "text/plain": {
          schema: { type: "object", properties: { a: { type: "string" } } },
        },
      },
    ],
  ];
  for (const [name, content] of degenerateCases) {
    it(`refuses a degenerate media/schema combination pre-dispatch: ${name}`, async () => {
      const spec = {
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        servers: [{ url: BASE }],
        paths: {
          "/op": {
            post: {
              operationId: "op",
              requestBody: { required: true, content },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      };
      const { fetch, requests } = mockFetch(() => jsonResponse({}));
      const call = new OpenAPIInvoker().invokeBinding({
        source: src(spec),
        selector: "#/paths/~1op/post",
        fetch,
      });
      await expect(call.closed).rejects.toMatchObject({
        code: ERR_REFUSED,
      });
      expect(requests).toHaveLength(0);
    });
  }

  // The degenerate-combination refusal reaches only a caller-selected
  // degenerate alternative: a caller-selected co-declared JSON media type
  // carries the same scalar schema with no refusal. Mirrors the Go SDK's
  // TestInvoke_DegenerateCombinationUnreachableWithJSONCoDeclared.
  it("honors caller-selected JSON over a degenerate multipart combination", async () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      servers: [{ url: BASE }],
      paths: {
        "/op": {
          post: {
            operationId: "op",
            requestBody: {
              required: true,
              content: {
                "multipart/form-data": { schema: { type: "string" } },
                "application/json": { schema: { type: "string" } },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker().invokeBinding({
      source: src(spec),
      selector: "#/paths/~1op/post",
      fetch,
      context: { configuration: { requestMedia: "application/json" } },
    });
    await call.write({ body: "x" });
    await single(call.outputs);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("Content-Type")).toBe("application/json");
    expect(requests[0]?.body).toBe('"x"');
  });

  // urlencoded selection serializes fields per the OAS encoding rules. With no
  // Encoding Object written, both properties take the CONTENT path on every
  // accepted edition (see revision3.test.ts and
  // design/openapi-30-urlencoded-default-lane-ruling.md).
  it("serializes a urlencoded body per the encoding rules", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      servers: [{ url: BASE }],
      paths: {
        "/form": {
          post: {
            operationId: "postForm",
            requestBody: {
              required: true,
              content: {
                "application/x-www-form-urlencoded": {
                  schema: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      ids: { type: "array", items: { type: "integer" } },
                    },
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker({ parameterConversion: String }).invokeBinding({
      source: src(spec),
      selector: "#/paths/~1form/post",
      fetch,
    });
    await call.write({ name: "a b", ids: [1, 2] });
    await single(call.outputs);
    expect(requests[0]?.headers.get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(requests[0]?.body).toBe("ids=%5B%221%22%2C%222%22%5D&name=a+b");
  });

  // Synthetic body unwrap on the wire: with an array body schema, the
  // caller's `body` field IS the request body.
  it("unwraps the synthetic body onto the wire", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      servers: [{ url: BASE }],
      paths: {
        "/batch": {
          post: {
            operationId: "batch",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { type: "array", items: { type: "integer" } },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker().invokeBinding({
      source: src(spec),
      selector: "#/paths/~1batch/post",
      fetch,
    });
    await call.write({ body: [1, 2] });
    await single(call.outputs);
    expect(requests[0]?.body).toBe("[1,2]");
  });

  // text/plain selection: a string body rides verbatim; the response
  // decodes through the text lane.
  it("sends a text/plain body verbatim and refuses a non-string one", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      servers: [{ url: BASE }],
      paths: {
        "/echo": {
          post: {
            operationId: "echo",
            requestBody: {
              required: true,
              content: { "text/plain": { schema: { type: "string" } } },
            },
            responses: {
              "200": {
                description: "ok",
                content: { "text/plain": { schema: { type: "string" } } },
              },
            },
          },
        },
      },
    };
    const inv = new OpenAPIInvoker();
    const { fetch, requests } = mockFetch(
      () =>
        new Response("pong", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
    );
    const call = inv.invokeBinding({
      source: src(spec),
      selector: "#/paths/~1echo/post",
      fetch,
    });
    await call.write({ body: "ping" });
    await expect(single(call.outputs)).resolves.toBe("pong");
    expect(requests[0]?.headers.get("Content-Type")).toBe("text/plain");
    expect(requests[0]?.body).toBe("ping");

    // The selection condition: a non-string body value refuses pre-dispatch.
    const call2 = inv.invokeBinding({
      source: src(spec),
      selector: "#/paths/~1echo/post",
      fetch,
    });
    await call2.write({ body: 1 });
    await expect(call2.closed).rejects.toMatchObject({
      code: ERR_REFUSED,
    });
    expect(requests).toHaveLength(1);
  });

  it("does not generate an Accept header from response declarations", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      servers: [{ url: BASE }],
      paths: {
        "/csvjson": {
          get: {
            operationId: "dual",
            responses: {
              "200": {
                description: "ok",
                content: { "application/json": {}, "text/csv": {} },
              },
              "404": {
                description: "nope",
                content: { "application/problem+json": {} },
              },
            },
          },
        },
      },
    };
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker().invokeBinding({
      source: src(spec),
      selector: "#/paths/~1csvjson/get",
      fetch,
    });
    await call.close();
    await single(call.outputs);
    expect(requests[0]?.headers.get("Accept")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OAPI-P-06 / §8 — interaction shape bounded by declaration
// ---------------------------------------------------------------------------

const DUAL_SPEC = {
  openapi: "3.0.3",
  info: { title: "t", version: "1" },
  servers: [{ url: BASE }],
  paths: {
    "/dual": {
      get: {
        operationId: "dual",
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": { schema: { type: "object" } },
              "text/event-stream": { schema: { type: "string" } },
            },
          },
        },
      },
    },
  },
};
const REF_DUAL = "#/paths/~1dual/get";

describe("OAPI-P-06 / §8 — interaction shape", () => {
  // A text/event-stream response on an operation that is NOT
  // streaming-capable is a protocol error, never a silent reclassification.
  it("treats an undeclared event-stream response as ERR_PROTOCOL", async () => {
    const { fetch } = mockFetch(() => sseResponse(["data: hi\n\n"]));
    const call = new OpenAPIInvoker().invokeBinding({
      source: src(WIDGET_SPEC),
      selector: "#/paths/~1session/get",
      fetch,
    });
    await call.close();
    await expect(call.closed).rejects.toMatchObject({ code: ERR_PROTOCOL });
  });

  it("delivers an SSE representation as one unary value while JSON remains unary", async () => {
    const inv = new OpenAPIInvoker();

    const { fetch: sseFetch } = mockFetch(() =>
      sseResponse(["data: one\n\ndata: two\n\n"]),
    );
    const streamCall = inv.invokeBinding({
      source: src(DUAL_SPEC),
      selector: REF_DUAL,
      fetch: sseFetch,
    });
    await streamCall.close();
    const events: unknown[] = [];
    for await (const e of streamCall.outputs) events.push(e);
    await streamCall.closed;
    expect(events).toEqual(["data: one\n\ndata: two\n\n"]);

    // JSON framing → unary.
    const { fetch: jsonFetch } = mockFetch(() =>
      jsonResponse({ mode: "unary" }),
    );
    const unaryCall = inv.invokeBinding({
      source: src(DUAL_SPEC),
      selector: REF_DUAL,
      fetch: jsonFetch,
    });
    await unaryCall.close();
    await expect(single(unaryCall.outputs)).resolves.toEqual({ mode: "unary" });
  });

});

// ---------------------------------------------------------------------------
// OAPI-P-07 — decode: charset handling and the empty-body rule
// ---------------------------------------------------------------------------

describe("OAPI-P-07 — decode", () => {
  const PING_REF = "#/paths/~1session/get";

  it("transcodes a declared latin-1 body", async () => {
    const { fetch } = mockFetch(
      () =>
        new Response(new Uint8Array([0xe9]), {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=iso-8859-1" },
        }),
    );
    const call = new OpenAPIInvoker().invokeBinding({
      source: src(WIDGET_SPEC),
      selector: PING_REF,
      fetch,
    });
    await call.close();
    await expect(single(call.outputs)).resolves.toBe("é");
  });

  it("treats invalid UTF-8 under the default charset as a loud decode error", async () => {
    const { fetch } = mockFetch(
      () =>
        new Response(new Uint8Array([0xff, 0xfe]), {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
    );
    const call = new OpenAPIInvoker().invokeBinding({
      source: src(WIDGET_SPEC),
      selector: PING_REF,
      fetch,
    });
    await call.close();
    await expect(call.closed).rejects.toMatchObject({
      code: ERR_RESPONSE_ERROR,
    });
  });

  it("treats an undecodable declared charset as a loud decode error", async () => {
    const { fetch } = mockFetch(
      () =>
        new Response("x", {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=shift_jis" },
        }),
    );
    const call = new OpenAPIInvoker().invokeBinding({
      source: src(WIDGET_SPEC),
      selector: PING_REF,
      fetch,
    });
    await call.close();
    await expect(call.closed).rejects.toMatchObject({
      code: ERR_RESPONSE_ERROR,
    });
  });

  it("emits no value for an empty body (204 included)", async () => {
    const { fetch } = mockFetch(() => new Response(null, { status: 204 }));
    const call = new OpenAPIInvoker().invokeBinding({
      source: src(WIDGET_SPEC),
      selector: PING_REF,
      fetch,
    });
    await call.close();
    const outs: unknown[] = [];
    for await (const o of call.outputs) outs.push(o);
    expect(outs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// OAPI-P-10 — channel assembly
// ---------------------------------------------------------------------------

describe("OAPI-P-10 — channel assembly", () => {
  // Declared cookie parameters and cookie-riding credentials merge into ONE
  // Cookie header: parameters in declaration order, credentials appended
  // after.
  it("merges cookie parameters and credentials into one Cookie header", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      servers: [{ url: BASE }],
      paths: {
        "/sess": {
          get: {
            operationId: "sess",
            security: [{ cookieKey: [] }],
            parameters: [
              { name: "zeta", in: "cookie", schema: { type: "string" } },
              { name: "alpha", in: "cookie", schema: { type: "string" } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
      components: {
        securitySchemes: {
          cookieKey: { type: "apiKey", in: "cookie", name: "auth_token" },
        },
      },
    };
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker().invokeBinding({
      source: src(spec),
      selector: "#/paths/~1sess/get",
      context: { apiKeys: { cookieKey: "secret" } },
      fetch,
    });
    await call.write({ zeta: "z", alpha: "a" });
    await single(call.outputs);
    // ONE header: declared params in declaration order (zeta before alpha),
    // the credential appended after.
    expect(requests[0]?.headers.get("Cookie")).toBe(
      "zeta=z; alpha=a; auth_token=secret",
    );
  });

  // A name collision between a credential and a caller-populated declared
  // parameter on the same channel refuses before dispatch.
  for (const tc of [
    { name: "header", in: "header", param: "X-Api-Key" },
    { name: "query", in: "query", param: "api_key" },
    { name: "cookie", in: "cookie", param: "session" },
  ]) {
    it(`refuses a credential/parameter collision on the ${tc.name} channel`, async () => {
      const spec = {
        openapi: "3.0.3",
        info: { title: "t", version: "1" },
        servers: [{ url: BASE }],
        paths: {
          "/x": {
            get: {
              operationId: "x",
              security: [{ key: [] }],
              parameters: [
                { name: tc.param, in: tc.in, schema: { type: "string" } },
              ],
              responses: { "200": { description: "ok" } },
            },
          },
        },
        components: {
          securitySchemes: {
            key: { type: "apiKey", in: tc.in, name: tc.param },
          },
        },
      };
      const { fetch, requests } = mockFetch(() => jsonResponse({}));
      const call = new OpenAPIInvoker().invokeBinding({
        source: src(spec),
        selector: "#/paths/~1x/get",
        context: { apiKey: "cred" },
        fetch,
      });
      await call.write({ [tc.param]: "caller-value" });
      await expect(call.closed).rejects.toMatchObject({
        code: ERR_REFUSED,
      });
      expect(requests).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// OAPI-P-05 — servers end to end
// ---------------------------------------------------------------------------

describe("OAPI-P-05 — the server configuration point end to end", () => {
  it("dispatches to the configured base URL, not the declared server", async () => {
    // The document declares an unrelated (unreachable) server; the consumer
    // configuration supplies the real base URL outright.
    const spec = {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      servers: [{ url: "https://unreachable.invalid" }],
      paths: {
        "/ping": {
          get: {
            operationId: "ping",
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const { fetch, requests } = mockFetch(() => jsonResponse({ ok: true }));
    const call = new OpenAPIInvoker().invokeBinding({
      source: src(spec),
      selector: "#/paths/~1ping/get",
      context: {
        configuration: { server: { baseUrl: "https://real.example.test" } },
      },
      fetch,
    });
    await call.close();
    await expect(single(call.outputs)).resolves.toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://real.example.test/ping");
  });
});

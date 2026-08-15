import { describe, expect, it } from "vitest";
import { CONTEXT_REQUIRED, ERR_REFUSED, type InvocationError } from "@openbindings/sdk";
import { BINDING_SPEC } from "./constants.js";
import { OpenAPIInvoker, OpenAPISynthesizer } from "./invoker.js";
import { convertToInterface } from "./synthesize.js";

function document(
  openapi: string,
  content: Record<string, unknown>,
  required = true,
): Record<string, unknown> {
  return {
    openapi,
    info: { title: "request carriage", version: "1" },
    servers: [{ url: "https://api.example" }],
    paths: {
      "/payload": {
        put: {
          operationId: "putPayload",
          requestBody: { required, content },
          responses: { "204": { description: "stored" } },
        },
      },
    },
  };
}

function captureFetch(): {
  fetch: typeof globalThis.fetch;
  requests: RequestInit[];
} {
  const requests: RequestInit[] = [];
  return {
    requests,
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(null, { status: 204 });
    },
  };
}

async function invoke(
  spec: unknown,
  input: unknown,
  context?: Record<string, unknown>,
): Promise<{ requests: RequestInit[]; error?: InvocationError }> {
  const captured = captureFetch();
  const call = new OpenAPIInvoker().invokeBinding({
    source: { bindingSpec: BINDING_SPEC, content: spec },
    ref: "#/paths/~1payload/put",
    context,
    fetch: captured.fetch,
  });
  await call.write(input).catch(() => {});
  let error: InvocationError | undefined;
  try {
    for await (const _output of call.outputs) { /* no output for 204 */ }
  } catch (caught: unknown) {
    error = caught as InvocationError;
  }
  return { requests: captured.requests, error };
}

async function invokeResponse(
  spec: unknown,
  input: unknown,
  response: Response,
): Promise<{ outputs: unknown[]; error?: InvocationError }> {
  const call = new OpenAPIInvoker().invokeBinding({
    source: { bindingSpec: BINDING_SPEC, content: spec },
    ref: "#/paths/~1payload/put",
    fetch: async () => response,
  });
  await call.write(input).catch(() => {});
  const outputs: unknown[] = [];
  let error: InvocationError | undefined;
  try {
    for await (const output of call.outputs) outputs.push(output);
  } catch (caught: unknown) {
    error = caught as InvocationError;
  }
  return { outputs, error };
}

describe("openbindings.openapi@1 request carriage", () => {
  it("projects and invokes a generic OAS 3.0 binary image as exact raw octets", async () => {
    const spec = document("3.0.4", {
      "image/png": { schema: { type: "string", format: "binary", title: "Image bytes" } },
    });
    const iface = await convertToInterface(undefined, spec, undefined, undefined, undefined, undefined, BINDING_SPEC);
    const input = iface.operations["putPayload"]?.input as Record<string, unknown>;
    expect(input).toEqual({
      type: "object",
      properties: {
        body: { type: "string", format: "binary", title: "Image bytes", contentEncoding: "base64" },
      },
      additionalProperties: false,
      required: ["body"],
    });

    const result = await invoke(spec, { body: "AAH+/w==" });
    expect(result.error).toBeUndefined();
    expect(result.requests).toHaveLength(1);
    expect(new Headers(result.requests[0]?.headers).get("content-type")).toBe("image/png");
    expect(Array.from(result.requests[0]?.body as Uint8Array)).toEqual([0, 1, 254, 255]);
  });

  it("uses Base64 only for an exact schema-omitted OAS 3.1 non-JSON declaration", async () => {
    const spec = document("3.1.2", { "image/png": {} });
    const iface = await convertToInterface(undefined, spec, undefined, undefined, undefined, undefined, BINDING_SPEC);
    const input = iface.operations["putPayload"]?.input as Record<string, unknown>;
    expect(input).toEqual({
      type: "object",
      properties: { body: { type: "string", contentEncoding: "base64" } },
      additionalProperties: false,
      required: ["body"],
    });

    const result = await invoke(spec, { body: "AAH+/w==" });
    expect(Array.from(result.requests[0]?.body as Uint8Array)).toEqual([0, 1, 254, 255]);
  });

  it.each([
    ["3.0.4", { schema: { type: "string", format: "binary" } }],
    ["3.1.2", {}],
  ])("uses configured image/* raw carriage under OAS %s", async (openapi, media) => {
    const spec = document(openapi, { "image/*": media });
    const iface = await convertToInterface(undefined, spec, undefined, undefined, undefined, undefined, BINDING_SPEC);
    const input = iface.operations["putPayload"]?.input as Record<string, unknown>;
    expect((input.properties as Record<string, unknown>)["body"]).toEqual({
      ...(openapi.startsWith("3.0") ? { type: "string", format: "binary" } : {}),
    });

    const result = await invoke(spec, { body: "AAH+/w==" }, {
      configuration: { requestMedia: "image/png" },
    });
    expect(result.error).toBeUndefined();
    expect(new Headers(result.requests[0]?.headers).get("content-type")).toBe("image/png");
    expect(Array.from(result.requests[0]?.body as Uint8Array)).toEqual([0, 1, 254, 255]);
  });

  it("requests media context before input for a required raw-capable range", async () => {
    const spec = document("3.1.2", { "image/*": {} });
    const result = await invoke(spec, { body: "AAH+/w==" });
    expect(result.requests).toHaveLength(0);
    expect(result.error?.code).toBe(CONTEXT_REQUIRED);
    expect(result.error?.data).toMatchObject({
      alternatives: [{ requirements: [{ type: "config.value", point: "requestMedia" }] }],
    });
  });

  it("exposes required range-only requestMedia through explicit preflight", async () => {
    const spec = document("3.1.2", { "image/*": {} });
    const details = await new OpenAPIInvoker().prepareBinding({
      source: { bindingSpec: BINDING_SPEC, content: spec },
      ref: "#/paths/~1payload/put",
    });
    expect(details).toMatchObject({
      target: "https://api.example",
      alternatives: [{ requirements: [{ type: "config.value", point: "requestMedia" }] }],
    });
  });

  it("refuses an optional supplied raw-capable range body without a concrete choice", async () => {
    const spec = document("3.1.2", { "image/*": {} }, false);
    const result = await invoke(spec, { body: "AAH+/w==" });
    expect(result.requests).toHaveLength(0);
    expect(result.error?.code).toBe(ERR_REFUSED);
  });

  it.each([
    ["application/json", undefined],
    ["application/*", { configuration: { requestMedia: "application/json" } }],
  ])("keeps schema-omitted %s on a stable synthetic whole-body route", async (declaration, context) => {
    const spec = document("3.1.2", { [declaration]: {} });
    const iface = await convertToInterface(undefined, spec, undefined, undefined, undefined, undefined, BINDING_SPEC);
    expect(iface.operations["putPayload"]?.input).toEqual({
      type: "object",
      properties: { body: {} },
      additionalProperties: false,
      required: ["body"],
    });
    for (const value of ["scalar", [1, 2], { name: "Ada" }]) {
      const result = await invoke(spec, { body: value }, context);
      expect(result.error).toBeUndefined();
      expect(result.requests[0]?.body).toBe(JSON.stringify(value));
    }
  });

  it("keeps an OAS 3.1 contentEncoding string encoded on the wire", async () => {
    const schema = {
      type: "string",
      contentMediaType: "image/png",
      contentEncoding: "base64",
      title: "Encoded image",
    };
    const spec = document("3.1.2", { "image/png": { schema } });
    const iface = await convertToInterface(undefined, spec, undefined, undefined, undefined, undefined, BINDING_SPEC);
    const input = iface.operations["putPayload"]?.input as Record<string, unknown>;
    expect((input.properties as Record<string, unknown>)["body"]).toEqual(schema);

    const result = await invoke(spec, { body: "AAH+/w==" });
    expect(result.requests[0]?.body).toBe("AAH+/w==");
  });

  it("resolves top-level OAS 3.1 contentEncoding through allOf and refuses deterministic conflicts", async () => {
    const inherited = document("3.1.2", {
      "image/png": {
        schema: {
          allOf: [
            { type: "string" },
            { contentEncoding: "base64", contentMediaType: "image/png" },
          ],
        },
      },
    });
    const invoked = await invoke(inherited, { body: "AAH+/w==" });
    expect(invoked.error).toBeUndefined();
    expect(invoked.requests[0]?.body).toBe("AAH+/w==");

    const conflicting = document("3.1.2", {
      "image/png": {
        schema: {
          allOf: [
            { type: "string", contentEncoding: "base64" },
            { contentEncoding: "base64url" },
          ],
        },
      },
    });
    await expect(convertToInterface(
      undefined,
      conflicting,
      undefined,
      undefined,
      undefined,
      undefined,
      BINDING_SPEC,
    )).rejects.toThrow(/conflicting contentEncoding.*base64.*base64url/);
  });

  it("admits an externally referenced OAS 3.1 encoded-string schema", async () => {
    const schemaURL = "https://schemas.example/encoded.json";
    const spec = document("3.1.2", {
      "image/png": { schema: { $ref: schemaURL } },
    });
    const fetchMock: typeof globalThis.fetch = async (input) => {
      expect(String(input)).toBe(schemaURL);
      return new Response(JSON.stringify({
        type: "string",
        contentEncoding: "base64",
        contentMediaType: "image/png",
        title: "External encoded image",
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const iface = await new OpenAPISynthesizer({ fetch: fetchMock }).synthesizeInterface({
      sources: [{ bindingSpec: BINDING_SPEC, content: spec }],
    });
    const input = iface.operations["putPayload"]?.input as Record<string, unknown>;
    expect((input.properties as Record<string, unknown>)["body"]).toMatchObject({
      type: "string",
      contentEncoding: "base64",
      contentMediaType: "image/png",
      title: "External encoded image",
    });
  });

  it("publishes OAS 3.0 Base64 only at multipart boundaries actually decoded", async () => {
    const spec = document("3.0.4", {
      "multipart/form-data": {
        schema: {
          type: "object",
          properties: {
            file: { type: "string", format: "binary" },
            files: {
              type: "array",
              items: { type: "string", format: "binary" },
            },
            nested: {
              type: "object",
              properties: { data: { type: "string", format: "binary" } },
            },
          },
        },
      },
    });
    const iface = await convertToInterface(undefined, spec, undefined, undefined, undefined, undefined, BINDING_SPEC);
    const input = iface.operations["putPayload"]?.input as Record<string, unknown>;
    const properties = input.properties as Record<string, Record<string, unknown>>;
    expect(properties["file"]).toMatchObject({ contentEncoding: "base64" });
    expect((properties["files"]?.items as Record<string, unknown>)).toMatchObject({
      contentEncoding: "base64",
    });
    const nested = properties["nested"]?.properties as Record<string, Record<string, unknown>>;
    expect(nested["data"]).not.toHaveProperty("contentEncoding");
  });

  it("decorates multipart candidate schemas without leaking into a shared JSON candidate", async () => {
    const shared = {
      type: "object",
      properties: { file: { type: "string", format: "binary" } },
    };
    const spec = document("3.0.4", {
      "application/json": { schema: shared },
      "multipart/form-data": { schema: shared },
    });
    const iface = await convertToInterface(undefined, spec, undefined, undefined, undefined, undefined, BINDING_SPEC);
    const input = iface.operations["putPayload"]?.input as Record<string, unknown>;
    const variants = input.anyOf as Array<Record<string, unknown>>;
    const files = variants.map((variant) =>
      (variant.properties as Record<string, Record<string, unknown>>)["file"]);
    expect(files.filter((file) => file?.contentEncoding === "base64")).toHaveLength(1);
    expect(files.filter((file) => !Object.hasOwn(file ?? {}, "contentEncoding"))).toHaveLength(1);
  });

  it.each([true, false])("preserves JSON boolean schema %j as a synthetic whole-body contract", async (schema) => {
    const spec = document("3.1.2", { "application/json": { schema } });
    const iface = await convertToInterface(undefined, spec, undefined, undefined, undefined, undefined, BINDING_SPEC);
    const input = iface.operations["putPayload"]?.input as Record<string, unknown>;
    expect((input.properties as Record<string, unknown>)["body"]).toBe(schema);
  });

  it("preserves boolean parameter and JSON output schemas", async () => {
    const spec = {
      openapi: "3.1.2",
      info: { title: "boolean schemas", version: "1" },
      paths: {
        "/boolean": {
          get: {
            operationId: "getBoolean",
            parameters: [{ name: "q", in: "query", schema: false }],
            responses: {
              "200": {
                description: "boolean",
                content: { "application/json": { schema: false } },
              },
            },
          },
        },
      },
    };
    const iface = await convertToInterface(undefined, spec, undefined, undefined, undefined, undefined, BINDING_SPEC);
    const input = iface.operations["getBoolean"]?.input as Record<string, unknown>;
    expect((input.properties as Record<string, unknown>)["q"]).toBe(false);
    expect(iface.operations["getBoolean"]?.output).toBe(false);
  });

  it("never treats present boolean schemas as omitted raw bodies", async () => {
    const exact = document("3.1.2", { "image/png": { schema: true } });
    const exactResult = await invoke(exact, { body: "AAH+/w==" });
    expect(exactResult.requests).toHaveLength(0);
    expect(exactResult.error?.code).toBe(ERR_REFUSED);

    const ranged = document("3.1.2", { "image/*": { schema: true } });
    const nonJSON = await invoke(ranged, { body: "AAH+/w==" }, {
      configuration: { requestMedia: "image/png" },
    });
    expect(nonJSON.requests).toHaveLength(0);
    expect(nonJSON.error?.code).toBe(ERR_REFUSED);
    const iface = await convertToInterface(undefined, ranged, undefined, undefined, undefined, undefined, BINDING_SPEC);
    const input = iface.operations["putPayload"]?.input as Record<string, unknown>;
    expect((input.properties as Record<string, unknown>)["body"]).toBe(true);
  });

  it("refuses an empty requestMedia consistently instead of treating it as missing context", async () => {
    const spec = document("3.1.2", { "application/*": { schema: { type: "object" } } });
    const source = { bindingSpec: BINDING_SPEC, content: spec };
    const context = { configuration: { requestMedia: "" } };
    expect(await new OpenAPIInvoker().prepareBinding({
      source,
      ref: "#/paths/~1payload/put",
      context,
    })).toBeNull();
    const result = await invoke(spec, { body: {} }, context);
    expect(result.requests).toHaveLength(0);
    expect(result.error?.code).toBe(ERR_REFUSED);
  });

  it("refuses invalid configured media syntax before dispatch", async () => {
    const spec = document("3.1.2", {
      "application/*": { schema: { type: "object" } },
    });
    const result = await invoke(spec, { name: "Ada" }, {
      configuration: { requestMedia: "application/json/extra" },
    });
    expect(result.requests).toHaveLength(0);
    expect(result.error?.code).toBe(ERR_REFUSED);
  });

  it("refuses non-canonical Base64 pad bits without dispatch", async () => {
    const spec = document("3.0.4", {
      "image/png": { schema: { type: "string", format: "binary" } },
    });
    const result = await invoke(spec, { body: "AB==" });
    expect(result.requests).toHaveLength(0);
    expect(result.error?.code).toBe(ERR_REFUSED);
  });

  it("retains a range's application schema and records its concrete-media requirement", async () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    const spec = document("3.1.2", { "application/*": { schema } });
    const synthesizer = new OpenAPISynthesizer();
    const result = await synthesizer.synthesizeInterfaceWithCoverage({
      sources: [{ bindingSpec: BINDING_SPEC, content: spec }],
    });
    expect(result.interface.operations["putPayload"]?.input).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    const target = result.coverage.entries.find((entry) => entry.scope === "target");
    const range = result.coverage.entries.find((entry) => entry.scope === "alternative");
    expect(target?.requirements).toContain("configuration.requestMedia");
    expect(range).toMatchObject({
      status: "represented",
      requirements: ["configuration.requestMedia"],
    });

    const invoked = await invoke(spec, { name: "Ada" }, {
      configuration: { requestMedia: "application/json" },
    });
    expect(invoked.error).toBeUndefined();
    expect(new Headers(invoked.requests[0]?.headers).get("content-type")).toBe("application/json");
    expect(invoked.requests[0]?.body).toBe('{"name":"Ada"}');
  });

  it("represents image/* object schemas through a possible +json member", async () => {
    const spec = document("3.1.2", {
      "image/*": { schema: { type: "object", properties: { name: { type: "string" } } } },
    }, false);
    const result = await new OpenAPISynthesizer().synthesizeInterfaceWithCoverage({
      sources: [{ bindingSpec: BINDING_SPEC, content: spec }],
    });
    const target = result.coverage.entries.find((entry) => entry.scope === "target");
    const range = result.coverage.entries.find((entry) => entry.scope === "alternative");
    expect(target).toMatchObject({ status: "represented", requirements: [] });
    expect(range).toMatchObject({
      status: "represented",
      requirements: ["configuration.requestMedia"],
    });
    expect(result.interface.operations["putPayload"]?.input).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
    });
    const invoked = await invoke(spec, { name: "Ada" }, {
      configuration: { requestMedia: "image/vendor+json" },
    });
    expect(invoked.error).toBeUndefined();
    expect(invoked.requests[0]?.body).toBe('{"name":"Ada"}');
  });

  it("safely refuses a mixed exact/range invocation when no preselected concrete lane works", async () => {
    const spec = document("3.1.2", {
      "text/plain": { schema: { type: "string" } },
      "application/*": {
        schema: { type: "object", properties: { name: { type: "string" } } },
      },
    });
    const result = await invoke(spec, { name: "Ada" });
    expect(result.requests).toHaveLength(0);
    expect(result.error?.code).toBe(ERR_REFUSED);
  });

  it.each([
    [
      "unsupported exact over a supported range",
      {
        "image/png": { schema: { type: "object" } },
        "image/*": { schema: { type: "string", contentEncoding: "base64" } },
      },
      "image/png",
    ],
    [
      "degenerate exact over a supported range",
      {
        "text/plain": { schema: { type: "object" } },
        "*/*": { schema: { type: "object" } },
      },
      "text/plain",
    ],
    [
      "equal-specificity tie containing an unsupported declaration",
      {
        "image/png; a=1": { schema: { type: "object" } },
        "image/png; b=2": { schema: { type: "string", contentEncoding: "base64" } },
      },
      "image/png; a=1; b=2",
    ],
  ])("ranks declarations before carriage admission: %s", async (_name, content, requestMedia) => {
    const spec = document("3.1.2", content);
    const result = await invoke(spec, { body: "AAH+/w==" }, {
      configuration: { requestMedia },
    });
    expect(result.requests).toHaveLength(0);
    expect(result.error?.code).toBe(ERR_REFUSED);
  });

  it("refuses an all-unsupported required inventory before dispatch", async () => {
    const spec = document("3.1.2", {
      "image/png": { schema: { type: "object" } },
    });
    const result = await invoke(spec, { body: { name: "Ada" } });
    expect(result.requests).toHaveLength(0);
    expect(result.error?.code).toBe(ERR_REFUSED);
  });

  it("encodes an exact Latin-1 text body as the declared wire octets", async () => {
    const spec = document("3.1.2", {
      "text/plain; charset=iso-8859-1": { schema: { type: "string" } },
    });
    const result = await invoke(spec, { body: "café" });
    expect(result.error).toBeUndefined();
    expect(new Headers(result.requests[0]?.headers).get("content-type"))
      .toBe("text/plain; charset=iso-8859-1");
    expect(Array.from(result.requests[0]?.body as Uint8Array)).toEqual([99, 97, 102, 233]);
  });

  it("refuses an unsupported charset selected through a media range before dispatch", async () => {
    const spec = document("3.1.2", {
      "text/*": { schema: { type: "string" } },
    });
    const result = await invoke(spec, { body: "hello" }, {
      configuration: { requestMedia: "text/plain; charset=utf-16" },
    });
    expect(result.requests).toHaveLength(0);
    expect(result.error?.code).toBe(ERR_REFUSED);
  });

  it.each([
    ["exact", "multipart/form-data; profile=demo; boundary=AaB03x", undefined],
    [
      "range",
      "multipart/*; profile=demo",
      { configuration: { requestMedia: "multipart/form-data; profile=demo; boundary=AaB03x" } },
    ],
  ])("preserves multipart parameters and an explicit boundary for an %s declaration", async (
    _kind,
    declaration,
    context,
  ) => {
    const spec = document("3.1.2", {
      [declaration]: {
        schema: {
          type: "object",
          properties: { note: { type: "string" } },
        },
      },
    });
    const result = await invoke(spec, { note: "hello" }, context);
    expect(result.error).toBeUndefined();
    expect(new Headers(result.requests[0]?.headers).get("content-type"))
      .toBe("multipart/form-data; boundary=AaB03x; profile=demo");
    const bytes = result.requests[0]?.body as Uint8Array;
    expect(new TextDecoder().decode(bytes)).toContain("--AaB03x\r\n");
  });

  it("applies explicit multipart style/explode and ignores contentType in that mode", async () => {
    const spec = document("3.1.2", {
      "multipart/form-data": {
        schema: {
          type: "object",
          properties: { tags: { type: "array", items: { type: "string" } } },
        },
        encoding: {
          tags: {
            style: "form",
            explode: false,
            contentType: "application/json, text/plain",
          },
        },
      },
    });
    const result = await invoke(spec, { tags: ["a/b", "c d"] });
    expect(result.error).toBeUndefined();
    const body = new TextDecoder().decode(result.requests[0]?.body as Uint8Array);
    expect(body).toContain('\r\n\r\na/b,c d\r\n');
    expect(body).not.toContain("application/json, text/plain");
  });

  it("uses explicit multipart allowReserved to activate RFC6570 serialization", async () => {
    const spec = document("3.1.2", {
      "multipart/form-data": {
        schema: {
          type: "object",
          properties: { note: { type: "string" } },
        },
        encoding: {
          note: {
            allowReserved: false,
            contentType: "text/custom",
          },
        },
      },
    });
    const result = await invoke(spec, { note: "a/b?c=d" });
    expect(result.error).toBeUndefined();
    const body = new TextDecoder().decode(result.requests[0]?.body as Uint8Array);
    expect(body).not.toContain("Content-Type: text/custom");
    expect(body).toContain("a/b?c=d");
  });

  it("uses a declared Latin-1 charset for a multipart string part", async () => {
    const spec = document("3.1.2", {
      "multipart/form-data": {
        schema: {
          type: "object",
          properties: {
            note: { type: "string", contentMediaType: "text/contradictory" },
          },
        },
        encoding: {
          note: { contentType: "text/plain; charset=iso-8859-1" },
        },
      },
    });
    const result = await invoke(spec, { note: "café" });
    expect(result.error).toBeUndefined();
    const bytes = Array.from(result.requests[0]?.body as Uint8Array);
    expect(bytes).toContain(233);
    expect(bytes).not.toContain(195);
    expect(new TextDecoder("latin1").decode(result.requests[0]?.body as Uint8Array))
      .toContain("Content-Type: text/plain; charset=iso-8859-1");
  });

  it("preserves an encoded OAS 3.1 string and emits its static transfer encoding", async () => {
    const spec = document("3.1.2", {
      "multipart/form-data": {
        schema: {
          type: "object",
          properties: {
            payload: {
              type: "string",
              contentEncoding: "base64",
              contentMediaType: "image/png",
            },
          },
        },
      },
    });
    const result = await invoke(spec, { payload: "AAH+/w==" });
    expect(result.error).toBeUndefined();
    const body = new TextDecoder().decode(result.requests[0]?.body as Uint8Array);
    expect(body).toContain("Content-Type: application/octet-stream");
    expect(body).toContain("Content-Transfer-Encoding: base64");
    expect(body).toContain("\r\n\r\nAAH+/w==\r\n");
    expect(body).not.toContain("Content-Type: image/png");
  });

  it("keeps an encoded string unquoted even when Encoding.contentType selects JSON", async () => {
    const spec = document("3.1.2", {
      "multipart/form-data": {
        schema: {
          type: "object",
          properties: { payload: { type: "string", contentEncoding: "base64" } },
        },
        encoding: { payload: { contentType: "application/json" } },
      },
    });
    const result = await invoke(spec, { payload: "AAH+/w==" });
    expect(result.error).toBeUndefined();
    const body = new TextDecoder().decode(result.requests[0]?.body as Uint8Array);
    expect(body).toContain("Content-Type: application/json");
    expect(body).toContain("Content-Transfer-Encoding: base64");
    expect(body).toContain("\r\n\r\nAAH+/w==\r\n");
    expect(body).not.toContain('"AAH+/w=="');
  });

  it("JSON-stringifies a plain string when Encoding.contentType selects JSON", async () => {
    const spec = document("3.1.2", {
      "multipart/form-data": {
        schema: {
          type: "object",
          properties: { note: { type: "string" } },
        },
        encoding: { note: { contentType: "application/json" } },
      },
    });
    const result = await invoke(spec, { note: "hello" });
    expect(result.error).toBeUndefined();
    const body = new TextDecoder().decode(result.requests[0]?.body as Uint8Array);
    expect(body).toContain('\r\n\r\n"hello"\r\n');
  });

  it("emits default multipart arrays as repeated same-name item parts", async () => {
    const spec = document("3.1.2", {
      "multipart/form-data": {
        schema: {
          type: "object",
          properties: { tags: { type: "array", items: { type: "string" } } },
        },
      },
    });
    const result = await invoke(spec, { tags: ["a", "b"] });
    expect(result.error).toBeUndefined();
    const body = new TextDecoder().decode(result.requests[0]?.body as Uint8Array);
    expect(body.match(/name="tags"/g)).toHaveLength(2);
    expect(body).toContain("\r\n\r\na\r\n");
    expect(body).toContain("\r\n\r\nb\r\n");
  });

  it.each([
    ["schema omission", {}],
    [
      "encoding headers",
      {
        schema: { type: "object", properties: { note: { type: "string" } } },
        encoding: { note: { headers: { "X-Part": { schema: { type: "string" } } } } },
      },
    ],
    [
      "ambiguous encoding content type",
      {
        schema: { type: "object", properties: { note: { type: "string" } } },
        encoding: { note: { contentType: "text/plain, application/json" } },
      },
    ],
    [
      "wildcard encoding content type",
      {
        schema: { type: "object", properties: { note: { type: "string" } } },
        encoding: { note: { contentType: "text/*" } },
      },
    ],
    [
      "multi-non-null choice part",
      { schema: { type: "object", properties: { note: { anyOf: [{ type: "string" }, { type: "integer" }] } } } },
    ],
    [
      "unsafe content transfer encoding",
      {
        schema: {
          type: "object",
          properties: { note: { type: "string", contentEncoding: "base64\r\nX-Injected: yes" } },
        },
      },
    ],
  ])("coverage-excludes multipart %s instead of guessing", async (_case, media) => {
    const spec = document("3.1.2", { "multipart/form-data": media }, false);
    const result = await new OpenAPISynthesizer().synthesizeInterfaceWithCoverage({
      sources: [{ bindingSpec: BINDING_SPEC, content: spec }],
    });
    expect(result.coverage.entries).toContainEqual(expect.objectContaining({
      scope: "alternative",
      status: "excluded",
      reasonCode: "openapi.request_media_excluded",
    }));
  });

  // §9.2: an unconstrained part schema (typeless, boolean true) is admitted
  // with its per-type default keyed by the value's JSON application type,
  // and a single-non-null-branch choice collapses to that branch.
  it.each([
    ["typeless 3.1 part", { schema: { type: "object", properties: { note: {} } } }],
    ["true 3.1 part", { schema: { type: "object", properties: { note: true } } }],
    [
      "nullable-choice part",
      { schema: { type: "object", properties: { note: { anyOf: [{ type: "string" }, { type: "null" }] } } } },
    ],
  ])("coverage-represents multipart %s (§9.2 part interpretation)", async (_case, media) => {
    const spec = document("3.1.2", { "multipart/form-data": media }, false);
    const result = await new OpenAPISynthesizer().synthesizeInterfaceWithCoverage({
      sources: [{ bindingSpec: BINDING_SPEC, content: spec }],
    });
    expect(result.coverage.entries).toContainEqual(expect.objectContaining({
      scope: "alternative",
      status: "represented",
    }));
  });

  it("coverage-excludes an exact schema-omitted urlencoded form", async () => {
    const spec = document("3.1.2", {
      "application/x-www-form-urlencoded": {},
    }, false);
    const result = await new OpenAPISynthesizer().synthesizeInterfaceWithCoverage({
      sources: [{ bindingSpec: BINDING_SPEC, content: spec }],
    });
    expect(result.coverage.entries).toContainEqual(expect.objectContaining({
      scope: "alternative",
      status: "excluded",
      reasonCode: "openapi.request_media_excluded",
    }));
  });

  it("coverage-excludes undefined multipart and urlencoded style-table cells", async () => {
    for (const [mediaType, encoding] of [
      ["multipart/form-data", { field: { style: "pipeDelimited", explode: false } }],
      ["application/x-www-form-urlencoded", { field: { style: "deepObject", explode: false } }],
    ] as const) {
      const spec = document("3.1.2", {
        [mediaType]: {
          schema: { type: "object", properties: { field: { type: "object" } } },
          encoding,
        },
      }, false);
      const result = await new OpenAPISynthesizer().synthesizeInterfaceWithCoverage({
        sources: [{ bindingSpec: BINDING_SPEC, content: spec }],
      });
      expect(result.coverage.entries).toContainEqual(expect.objectContaining({
        scope: "alternative",
        status: "excluded",
      }));
    }
  });

  it.each([
    ["multipart/*", "multipart/form-data"],
    ["application/*", "application/x-www-form-urlencoded"],
  ])("retains schema-omitted range %s but refuses its configured form lane", async (
    declaration,
    requestMedia,
  ) => {
    const spec = document("3.1.2", { [declaration]: {} });
    const synthesized = await new OpenAPISynthesizer().synthesizeInterfaceWithCoverage({
      sources: [{ bindingSpec: BINDING_SPEC, content: spec }],
    });
    expect(synthesized.coverage.entries).toContainEqual(expect.objectContaining({
      scope: "alternative",
      status: "represented",
      requirements: ["configuration.requestMedia"],
    }));
    const result = await invoke(spec, { body: { note: "hello" } }, {
      configuration: { requestMedia },
    });
    expect(result.requests).toHaveLength(0);
    expect(result.error?.code).toBe(ERR_REFUSED);
  });

  it("does not let an unreachable false multipart property poison its candidate", async () => {
    const spec = document("3.1.2", {
      "multipart/form-data": {
        schema: {
          type: "object",
          properties: {
            impossible: false,
            note: { type: "string" },
          },
        },
      },
    });
    const result = await invoke(spec, { note: "hello" });
    expect(result.error).toBeUndefined();
    expect(result.requests).toHaveLength(1);
  });

  it("uses content-based urlencoded serialization when no RFC6570 fields are explicit", async () => {
    const spec = document("3.1.2", {
      "application/x-www-form-urlencoded": {
        schema: {
          type: "object",
          properties: {
            address: { type: "object" },
            note: { type: "string" },
            payload: { type: "string", contentEncoding: "base64" },
          },
        },
        encoding: {
          note: { contentType: "text/plain; charset=iso-8859-1" },
        },
      },
    });
    const result = await invoke(spec, {
      address: { city: "New York" },
      note: "café",
      payload: "AAH+/w==",
    });
    expect(result.error).toBeUndefined();
    expect(result.requests[0]?.body).toBe(
      "address=%7B%22city%22%3A%22New+York%22%7D&note=caf%E9&payload=AAH%2B%2Fw%3D%3D",
    );
  });

  it("preserves the older OAS 3.0.3 form defaults when encoding fields are absent", async () => {
    const spec = document("3.0.3", {
      "application/x-www-form-urlencoded": {
        schema: {
          type: "object",
          properties: {
            ids: { type: "array", items: { type: "integer" } },
            name: { type: "string" },
          },
        },
      },
    });
    const result = await invoke(spec, { ids: [1, 2], name: "a b" });
    expect(result.error).toBeUndefined();
    expect(result.requests[0]?.body).toBe("ids=1&ids=2&name=a%20b");
  });

  it("uses RFC6570 percent encoding for explicit urlencoded style fields", async () => {
    const spec = document("3.1.2", {
      "application/x-www-form-urlencoded": {
        schema: {
          type: "object",
          properties: { address: { type: "object" } },
        },
        encoding: {
          address: { style: "form", explode: true },
        },
      },
    });
    const result = await invoke(spec, { address: { city: "New York" } });
    expect(result.error).toBeUndefined();
    expect(result.requests[0]?.body).toBe("city=New%20York");
  });

  it("keeps urlencoded structural delimiters escaped even with allowReserved", async () => {
    const spec = document("3.1.2", {
      "application/x-www-form-urlencoded": {
        schema: {
          type: "object",
          properties: { note: { type: "string" } },
        },
        encoding: {
          note: { style: "form", explode: true, allowReserved: true },
        },
      },
    });
    const result = await invoke(spec, { note: "a&b+c#d[e]=f" });
    expect(result.error).toBeUndefined();
    expect(result.requests[0]?.body).toBe("note=a%26b%2Bc%23d%5Be%5D%3Df");
  });

  it("decodes a revision-3 unary response using its declared Latin-1 charset", async () => {
    const spec = document("3.1.2", {
      "application/json": { schema: { type: "object" } },
    });
    const operation = ((spec.paths as Record<string, any>)["/payload"].put as Record<string, unknown>);
    operation.responses = {
      "200": {
        description: "text",
        content: { "text/plain; charset=iso-8859-1": { schema: { type: "string" } } },
      },
    };
    const result = await invokeResponse(spec, {}, new Response(new Uint8Array([99, 97, 102, 233]), {
      status: 200,
      headers: { "content-type": "text/plain; charset=iso-8859-1" },
    }));
    expect(result.error).toBeUndefined();
    expect(result.outputs).toEqual(["café"]);
  });

  it("treats an explicitly empty response charset as unsupported, not absent", async () => {
    const spec = document("3.1.2", {
      "application/json": { schema: { type: "object" } },
    });
    const operation = ((spec.paths as Record<string, any>)["/payload"].put as Record<string, unknown>);
    operation.responses = {
      "200": {
        description: "text",
        content: { 'text/plain; charset=""': { schema: { type: "string" } } },
      },
    };
    const result = await invokeResponse(spec, {}, new Response("hello", {
      status: 200,
      headers: { "content-type": 'text/plain; charset=""' },
    }));
    expect(result.outputs).toHaveLength(0);
    expect(result.error?.code).toBe("ERR_RESPONSE_ERROR");
  });

  it("refuses a folded multiple Content-Type success header", async () => {
    const spec = document("3.1.2", {
      "application/json": { schema: { type: "object" } },
    });
    const operation = ((spec.paths as Record<string, any>)["/payload"].put as Record<string, unknown>);
    operation.responses = {
      "200": {
        description: "text",
        content: { "text/plain": { schema: { type: "string" } } },
      },
    };
    const result = await invokeResponse(spec, {}, new Response("hello", {
      status: 200,
      headers: { "content-type": "text/plain, application/json" },
    }));
    expect(result.outputs).toHaveLength(0);
    expect(result.error?.code).toBe("ERR_PROTOCOL");
  });

  it("completes an empty 2xx before applying stray SSE declaration checks", async () => {
    const spec = document("3.1.2", {
      "application/json": { schema: { type: "object" } },
    });
    const operation = ((spec.paths as Record<string, any>)["/payload"].put as Record<string, unknown>);
    operation.responses = { "200": { description: "empty" } };
    const result = await invokeResponse(spec, {}, new Response(null, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    expect(result.error).toBeUndefined();
    expect(result.outputs).toEqual([]);
  });

  it.each([
    ["valid UTF-8", new TextEncoder().encode("data: café\n\n"), "café"],
    ["malformed UTF-8", new Uint8Array([100, 97, 116, 97, 58, 32, 233, 10, 10]), "�"],
  ])("decodes SSE as WHATWG UTF-8 replacement mode despite a charset parameter: %s", async (
    _case,
    body,
    expected,
  ) => {
    const spec = document("3.1.2", {
      "application/json": { schema: { type: "object" } },
    });
    const operation = ((spec.paths as Record<string, any>)["/payload"].put as Record<string, unknown>);
    operation.responses = {
      "200": {
        description: "events",
        content: { "text/event-stream": { schema: { type: "string" } } },
      },
    };
    const result = await invokeResponse(spec, {}, new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=iso-8859-1" },
    }));
    expect(result.error).toBeUndefined();
    expect(result.outputs).toEqual([expected]);
  });

  // §9.2's string-carriage lane is declaration-scoped (ruled 2026-08-15):
  // the lane is selected when the governing schema resolves to `type:
  // string`. A boolean `true` schema declares no type, so it selects no
  // lane, and an OAS 3.1 raw lane needs an OMITTED schema rather than an
  // unconstrained one. This narrows what the incumbent unconditional
  // text/plain lane accepted; the corner is filed for a ruling (queue item
  // 11 residue in unsupervised-loop.md) rather than repaired by inventing an
  // "unconstrained schema" admissibility rule the ruling does not state.
  // Pinned here and in Go's TestRequestStringCarriage_DeclarationScoped so
  // the twins cannot drift while the corner is open.
  it("selects no lane for an unconstrained boolean text schema", async () => {
    const spec = document("3.1.2", { "text/plain": { schema: true } });
    await expect(convertToInterface(
      undefined,
      spec,
      undefined,
      undefined,
      undefined,
      undefined,
      BINDING_SPEC,
    )).rejects.toThrow(/selects a request carriage lane/);
  });
});

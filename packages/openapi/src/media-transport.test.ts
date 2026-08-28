import { describe, expect, it } from "vitest";
import {
  governRequest,
  governResponse,
  normalizeContentCodings,
  type ContentDecoder,
  type ContentEncoder,
  type MediaGovernanceModel,
} from "./media-transport.js";
import type { OpenAPIDocument, OpenAPIOperation } from "./types.js";

describe("HTTP media transport governance", () => {
  it("applies coding stacks in wire order and reverse order while omitting Accept", async () => {
    const model = codingModel();
    const encode = new Map<string, ContentEncoder>([
      ["first", wrap("first")],
      ["second", wrap("second")],
    ]);
    const decodeOrder: string[] = [];
    const decode = new Map<string, ContentDecoder>([
      ["first", unwrap("first", decodeOrder)],
      ["second", unwrap("second", decodeOrder)],
    ]);

    const governedRequest = await governRequest("https://example.test/x", {
      method: "POST",
      headers: {
        Accept: "text/plain",
        "Content-Encoding": "first, identity, second",
      },
      body: "payload",
    }, model, encode);
    const requestHeaders = new Headers(governedRequest.init?.headers);
    expect(requestHeaders.has("Accept")).toBe(false);
    expect(await new Response(governedRequest.init?.body).text()).toBe("second(first(payload))");

    const governedResponse = await governResponse(new Response("second(first(payload))", {
      status: 200,
      headers: {
        "Content-Type": "text/plain",
        "Content-Encoding": "first, identity, second",
        "X-Required": "yes",
      },
    }), model, decode);
    expect(await governedResponse.text()).toBe("payload");
    expect(decodeOrder).toEqual(["second", "first"]);
  });

  it("normalizes finite capability maps case-insensitively and rejects collisions", () => {
    const codec = wrap("x");
    const normalized = normalizeContentCodings({ " FIRST ": codec }, "request");
    expect(normalized.defect).toBeUndefined();
    expect(normalized.codecs.get("first")).toBe(codec);

    const collision = normalizeContentCodings({ First: codec, first: codec }, "request");
    expect(collision.defect).toBeInstanceOf(Error);
  });

  it("refuses ungoverned request codings and reports response coding defects as protocol errors", async () => {
    const ungovernedRequest = codingModel();
    ungovernedRequest.parameters = [];
    await expect(governRequest("https://example.test/x", {
      method: "POST",
      headers: { "Content-Encoding": "first" },
      body: "payload",
    }, ungovernedRequest, new Map([["first", wrap("first")]]))).rejects.toMatchObject({
      code: "ERR_REFUSED",
    });

    const malformedResponse = codingModel();
    const malformedHeaders = malformedResponse.operation.responses?.["200"]?.headers;
    const responseHeader = malformedHeaders?.["Content-Encoding"];
    if (responseHeader && typeof responseHeader === "object") responseHeader.schema = { type: "string" };
    await expect(governResponse(new Response("payload", {
      status: 200,
      headers: {
        "Content-Type": "text/plain",
        "Content-Encoding": "first,,second",
        "X-Required": "yes",
      },
    }), malformedResponse, new Map())).rejects.toMatchObject({ code: "ERR_PROTOCOL" });

    const ungovernedResponse = codingModel();
    const ungovernedHeaders = ungovernedResponse.operation.responses?.["200"]?.headers as
      | Record<string, unknown>
      | undefined;
    if (ungovernedHeaders) delete ungovernedHeaders["Content-Encoding"];
    await expect(governResponse(new Response("payload", {
      status: 200,
      headers: {
        "Content-Type": "text/plain",
        "Content-Encoding": "first",
        "X-Required": "yes",
      },
    }), ungovernedResponse, new Map([["first", unwrap("first", [])]]))).rejects.toMatchObject({
      code: "ERR_PROTOCOL",
    });
  });

  it("enforces required response headers, assumes octets, and defines HEAD as empty", async () => {
    const required = codingModel();
    await expect(governResponse(new Response("payload", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    }), required, new Map())).rejects.toMatchObject({ code: "ERR_PROTOCOL" });

    const octets = responseModel("get", {
      "200": {
        description: "ok",
        content: { "application/octet-stream": {} },
      },
    });
    const governed = await governResponse(new Response(new TextEncoder().encode("octets"), { status: 200 }), octets, new Map());
    expect(governed.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(await governed.text()).toBe("octets");

    const head = responseModel("head", {
      "200": {
        description: "ok",
        content: { "application/octet-stream": {} },
      },
    });
    const headResponse = await governResponse(new Response(new TextEncoder().encode("ignored"), { status: 200 }), head, new Map());
    expect(head.emptyResponse).toBe(true);
    expect((await headResponse.arrayBuffer()).byteLength).toBe(0);
  });
});

function codingModel(): MediaGovernanceModel {
  return responseModel("post", {
    "200": {
      description: "ok",
      headers: {
        "Content-Encoding": {
          required: true,
          schema: { type: "string", enum: ["first, identity, second"] },
        },
        "X-Required": { required: true, schema: { type: "string" } },
      },
      content: { "text/plain": { schema: { type: "string" } } },
    },
  }, [{
    name: "Content-Encoding",
    in: "header",
    required: true,
    schema: { type: "string", enum: ["first, identity, second"] },
  }]);
}

function responseModel(
  method: string,
  responses: NonNullable<OpenAPIOperation["responses"]>,
  parameters: NonNullable<OpenAPIOperation["parameters"]> = [],
): MediaGovernanceModel {
  const operation: OpenAPIOperation = { responses, parameters };
  const document = {
    openapi: "3.1.1",
    info: { title: "t", version: "1" },
    paths: { "/x": { [method]: operation } },
  } as OpenAPIDocument;
  return {
    document,
    operation,
    parameters,
    method,
    emptyResponse: false,
  };
}

function wrap(name: string): ContentEncoder {
  return (body) => new TextEncoder().encode(`${name}(${new TextDecoder().decode(body)})`);
}

function unwrap(name: string, order: string[]): ContentDecoder {
  return (body) => {
    order.push(name);
    const text = new TextDecoder().decode(body);
    const prefix = `${name}(`;
    if (!text.startsWith(prefix) || !text.endsWith(")")) throw new Error("malformed coding");
    return new TextEncoder().encode(text.slice(prefix.length, -1));
  };
}

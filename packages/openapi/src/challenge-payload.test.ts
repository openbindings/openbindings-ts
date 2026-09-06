// The CONTEXT_REQUIRED payload of the two media configuration points on the
// three 3.x lines is the standalone client's own challenge passed through
// unchanged: scoped to the resolved server base, durable, with the same
// prompt text the Go engine carries, on the invocation AND the preflight
// surface. Before this test the adapter re-minted both payloads with an
// empty target and no durable flag, so a runtime keying context by target
// could name the point but not say where the choice applied.
import { describe, expect, it, vi } from "vitest";
import { InvocationError } from "@openbindings/invoke";
import {
  PROPERTY_MEDIA_REQUIREMENT_DESCRIPTION,
  REQUEST_MEDIA_REQUIREMENT_DESCRIPTION,
} from "@openbindings/openapi-client/provider";
import { OpenAPIInvoker } from "./invoker.js";

const LINES: Array<[string, string]> = [
  ["3.0.4", "openbindings.openapi-3.0@1"],
  ["3.1.2", "openbindings.openapi-3.1@1"],
  ["3.2.0", "openbindings.openapi-3.2@1"],
];

const SERVER = "https://api.example";

function document(openapi: string, paths: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    openapi,
    info: { title: "challenge payload", version: "1" },
    servers: [{ url: SERVER }],
    paths,
    ...extra,
  });
}

function requestMediaDocument(openapi: string): string {
  return document(openapi, {
    "/p": {
      post: {
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { type: "string" } },
            "text/plain": { schema: { type: "string" } },
          },
        },
        responses: { "204": { description: "ok" } },
      },
    },
  });
}

function propertyMediaDocument(openapi: string): string {
  // 3.0: a part declaring no type reaches no default row (OAPI30-PS-56).
  // 3.1/3.2: a typeless part defaults to octet-stream, so the point is made
  // live by an Encoding contentType that is a media RANGE instead.
  const oas30 = openapi.startsWith("3.0");
  return document(openapi, {
    "/upload": {
      post: {
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": oas30
              ? { schema: { type: "object", properties: { profile: { description: "a part declaring no type" } } } }
              : {
                  schema: { type: "object", properties: { profile: { type: "string" } } },
                  encoding: { profile: { contentType: "image/*" } },
                },
          },
        },
        responses: { "204": { description: "stored" } },
      },
    },
  });
}

function serverChoiceDocument(openapi: string): string {
  const content = JSON.parse(document(openapi, {
    "/ping": { get: { responses: { "204": { description: "ok" } } } },
  })) as Record<string, unknown>;
  content.servers = [{ url: "https://a.example" }, { url: "https://b.example" }];
  return JSON.stringify(content);
}

function securityChoiceDocument(openapi: string): string {
  return document(openapi, {
    "/secured": {
      get: {
        security: [{ oauth: [] }, { bearer: [] }],
        responses: { "204": { description: "ok" } },
      },
    },
  }, {
    components: {
      securitySchemes: {
        oauth: {
          type: "oauth2",
          flows: { clientCredentials: { tokenUrl: "https://auth.example/token", scopes: {} } },
        },
        bearer: { type: "http", scheme: "bearer" },
      },
    },
  });
}

async function challenge(bindingSpec: string, content: string, selector: string, input: unknown): Promise<unknown> {
  let dispatched = false;
  const call = new OpenAPIInvoker().invokeBinding({
    source: { bindingSpec, content },
    selector,
    fetch: async () => {
      dispatched = true;
      return new Response(null, { status: 204 });
    },
  });
  try {
    await call.write(input);
    await call.close?.();
    for await (const _ of call.outputs) void _;
    await call.closed;
  } catch (error) {
    if (!(error instanceof InvocationError)) throw error;
    expect(error.code).toBe("CONTEXT_REQUIRED");
    expect(dispatched).toBe(false);
    return error.data;
  }
  throw new Error("expected a CONTEXT_REQUIRED terminal");
}

function preflight(bindingSpec: string, content: string, selector: string): Promise<unknown> {
  return new OpenAPIInvoker().prepareBinding({ source: { bindingSpec, content }, selector });
}

async function terminalError(
  bindingSpec: string,
  content: string,
  selector: string,
  context: Record<string, unknown>,
): Promise<InvocationError> {
  const call = new OpenAPIInvoker().invokeBinding({
    source: { bindingSpec, content },
    selector,
    context,
    fetch: async () => {
      throw new Error("a refused invocation must not dispatch");
    },
  });
  try {
    await call.close();
    for await (const _ of call.outputs) void _;
    await call.closed;
  } catch (error) {
    if (error instanceof InvocationError) return error;
    throw error;
  }
  throw new Error("expected an invocation error");
}

const requestMediaChallenge = {
  target: SERVER,
  alternatives: [{
    requirements: [{
      type: "config.value",
      point: "requestMedia",
      path: "",
      description: REQUEST_MEDIA_REQUIREMENT_DESCRIPTION,
      durable: true,
    }],
  }],
};

const propertyMediaChallenge = {
  target: SERVER,
  alternatives: [{
    requirements: [{
      type: "config.value",
      point: "propertyMedia",
      path: "/profile",
      description: PROPERTY_MEDIA_REQUIREMENT_DESCRIPTION,
      durable: true,
    }],
  }],
};

describe.each(LINES)("challenge payload on OpenAPI %s", (openapi, bindingSpec) => {
  it("scopes the requestMedia challenge to the resolved server base, durable, on both surfaces", async () => {
    const content = requestMediaDocument(openapi);
    await expect(challenge(bindingSpec, content, "#/paths/~1p/post", { body: "hello" }))
      .resolves.toEqual(requestMediaChallenge);
    await expect(preflight(bindingSpec, content, "#/paths/~1p/post"))
      .resolves.toEqual(requestMediaChallenge);
  });

  it("scopes the propertyMedia challenge to the resolved server base, durable, on both surfaces", async () => {
    const content = propertyMediaDocument(openapi);
    await expect(challenge(bindingSpec, content, "#/paths/~1upload/post", { body: { profile: "QUFB" } }))
      .resolves.toEqual(propertyMediaChallenge);
    await expect(preflight(bindingSpec, content, "#/paths/~1upload/post"))
      .resolves.toEqual(propertyMediaChallenge);
  });

  it("passes the client's server challenge through with its durability and schema", async () => {
    const content = serverChoiceDocument(openapi);
    const expected = {
      // The server point precedes destination resolution, so the asserted
      // scope is the artifact's own identity, and a content-only source has
      // none: the target is empty, as it is in the Go engine.
      target: "",
      alternatives: [{
        requirements: [{
          type: "config.value",
          point: "server",
          path: "/url",
          description: "the effective server list has 2 alternatives; configuration.server must select one",
          schema: { enum: ["https://a.example", "https://b.example"] },
          durable: true,
        }],
      }],
    };
    await expect(challenge(bindingSpec, content, "#/paths/~1ping/get", undefined)).resolves.toEqual(expected);
    await expect(preflight(bindingSpec, content, "#/paths/~1ping/get")).resolves.toEqual(expected);
  });

  it("consumes the server challenge's canonical /url selection", async () => {
    const content = serverChoiceDocument(openapi);
    const fetch = vi.fn(async (_input: string | URL | Request) => new Response(null, { status: 204 }));
    const args = {
      source: { bindingSpec, content },
      selector: "#/paths/~1ping/get",
      context: { configuration: { server: { url: "https://b.example" } } },
      fetch,
    };
    await expect(new OpenAPIInvoker().prepareBinding(args)).resolves.toBeNull();
    const call = new OpenAPIInvoker().invokeBinding(args);
    await call.close();
    for await (const _ of call.outputs) void _;
    await call.closed;
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = fetch.mock.calls[0]?.[0];
    expect(request instanceof Request ? request.url : String(request)).toBe("https://b.example/ping");
  });

  it("maps the client's security choice to configuration.security/index", async () => {
    const content = securityChoiceDocument(openapi);
    const expected = {
      target: SERVER,
      alternatives: [{
        requirements: [{
          type: "config.value",
          point: "security",
          path: "/index",
          description: "select one complete declared security alternative",
          schema: { enum: [0, 1] },
          durable: true,
        }],
      }],
    };
    await expect(challenge(bindingSpec, content, "#/paths/~1secured/get", undefined)).resolves.toEqual(expected);
    await expect(preflight(bindingSpec, content, "#/paths/~1secured/get")).resolves.toEqual(expected);
  });

  it.each([
    null,
    [],
    {},
    "0",
    { index: "0" },
    { index: -1 },
    { index: 0, ignored: true },
  ])("refuses malformed security selection %#", async (security) => {
    const error = await terminalError(
      bindingSpec,
      securityChoiceDocument(openapi),
      "#/paths/~1secured/get",
      { configuration: { security } },
    );
    expect(error.code).toBe("ERR_REFUSED");
  });

  it.each([
    { url: "https://unlisted.example" },
    { url: "https://b.example", ignored: true },
    { index: 0, variables: null },
    { index: 0, ignored: true },
    { baseUrl: "https://b.example", variables: {} },
  ])("refuses malformed or unlisted server selection %#", async server => {
    const error = await terminalError(bindingSpec, serverChoiceDocument(openapi), "#/paths/~1ping/get", { configuration: { server } });
    expect(error.code).toBe("ERR_REFUSED");
  });
});

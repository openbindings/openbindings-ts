import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAPIClient } from "@openbindings/openapi-client";
import { OpenAPIInvoker } from "./invoker.js";

const DOCUMENT = {
  openapi: "3.1.2",
  info: { title: "content revision cache", version: "1" },
  servers: [{ url: "https://api.example.test" }],
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        responses: { "204": { description: "ok" } },
      },
    },
  },
};

describe("native OpenAPI source cache", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reuses one executable client for an identical content-only revision", async () => {
    const load = vi.spyOn(OpenAPIClient, "load");
    const fetch = vi.fn(async () => new Response(null, { status: 204 })) as typeof globalThis.fetch;
    const invoker = new OpenAPIInvoker();

    for (let index = 0; index < 2; index++) {
      const call = invoker.invokeBinding({
        source: { bindingSpec: "openbindings.openapi-3.1@1", content: DOCUMENT },
        selector: "#/paths/~1ping/get",
        fetch,
      });
      await call.close();
      for await (const _ of call.outputs) void _;
      await call.closed;
    }

    expect(load).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("creates a new revision when inline content changes at one location", async () => {
    const load = vi.spyOn(OpenAPIClient, "load");
    const fetch = vi.fn(async () => new Response(null, { status: 204 })) as typeof globalThis.fetch;
    const invoker = new OpenAPIInvoker();

    for (const version of ["1", "2"]) {
      const call = invoker.invokeBinding({
        source: {
          bindingSpec: "openbindings.openapi-3.1@1",
          location: "https://example.test/openapi.json",
          content: { ...DOCUMENT, info: { ...DOCUMENT.info, version } },
        },
        selector: "#/paths/~1ping/get",
        fetch,
      });
      await call.close();
      for await (const _ of call.outputs) void _;
      await call.closed;
    }

    expect(load).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps a location-only revision distinct from co-present embedded content", async () => {
    const loaded = vi.spyOn(OpenAPIClient, "load");
    const documentURL = "https://documents.example.test/openapi.json";
    const dispatched: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === documentURL) {
        return new Response(JSON.stringify({
          ...DOCUMENT,
          servers: [{ url: "https://first.example.test" }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      dispatched.push(url);
      return new Response(null, { status: 204 });
    }) as typeof globalThis.fetch;
    const invoker = new OpenAPIInvoker();

    for (const source of [
      { bindingSpec: "openbindings.openapi-3.1@1", location: documentURL },
      {
        bindingSpec: "openbindings.openapi-3.1@1",
        location: documentURL,
        content: { ...DOCUMENT, servers: [{ url: "https://second.example.test" }] },
      },
      { bindingSpec: "openbindings.openapi-3.1@1", location: documentURL },
    ]) {
      const call = invoker.invokeBinding({
        source,
        selector: "#/paths/~1ping/get",
        fetch,
      });
      await call.close();
      for await (const _ of call.outputs) void _;
      await call.closed;
    }

    expect(loaded).toHaveBeenCalledTimes(3);
    expect(dispatched).toEqual([
      "https://first.example.test/ping",
      "https://second.example.test/ping",
      "https://first.example.test/ping",
    ]);
  });

  it("loads uncached when Web Crypto hashing is unavailable", async () => {
    const load = vi.spyOn(OpenAPIClient, "load");
    const savedCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    try {
      const fetch = vi.fn(async () => new Response(null, { status: 204 })) as typeof globalThis.fetch;
      const invoker = new OpenAPIInvoker();
      for (let index = 0; index < 2; index++) {
        const call = invoker.invokeBinding({
          source: { bindingSpec: "openbindings.openapi-3.1@1", content: DOCUMENT },
          selector: "#/paths/~1ping/get",
          fetch,
        });
        await call.close();
        for await (const _ of call.outputs) void _;
        await call.closed;
      }
      expect(load).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      if (savedCrypto) Object.defineProperty(globalThis, "crypto", savedCrypto);
      else delete (globalThis as { crypto?: Crypto }).crypto;
    }
  });

  it("retrieves a changed location document on each invocation", async () => {
    let revision = 0;
    const destinations: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://documents.example.test/openapi.json") {
        return Response.json({ ...DOCUMENT, servers: [{ url: `https://revision${++revision}.example.test` }] });
      }
      destinations.push(url);
      return new Response(null, { status: 204 });
    });
    const invoker = new OpenAPIInvoker();
    for (let index = 0; index < 2; index++) {
      const call = invoker.invokeBinding({
        source: { bindingSpec: "openbindings.openapi-3.1@1", location: "https://documents.example.test/openapi.json" },
        selector: "#/paths/~1ping/get", fetch,
      });
      await call.close();
      for await (const _ of call.outputs) void _;
      await call.closed;
    }
    expect(destinations).toEqual(["https://revision1.example.test/ping", "https://revision2.example.test/ping"]);
  });

  it("does not reuse external references across invocation fetch contexts", async () => {
    const invoker = new OpenAPIInvoker();
    const content = { ...DOCUMENT, paths: { "/ping": { $ref: "https://documents.example.test/path.json" } } };
    const destinations: string[] = [];
    for (const revision of [1, 2]) {
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === "https://documents.example.test/path.json") {
          return Response.json({
            servers: [{ url: `https://revision${revision}.example.test` }],
            get: DOCUMENT.paths["/ping"].get,
          });
        }
        destinations.push(url);
        return new Response(null, { status: 204 });
      });
      const call = invoker.invokeBinding({
        source: { bindingSpec: "openbindings.openapi-3.1@1", content },
        selector: "#/paths/~1ping/get", fetch,
      });
      await call.close();
      for await (const _ of call.outputs) void _;
      await call.closed;
    }
    expect(destinations).toEqual(["https://revision1.example.test/ping", "https://revision2.example.test/ping"]);
  });
});

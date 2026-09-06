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

  it("makes location-only advisory reuse follow the newest content revision", async () => {
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

    expect(loaded).toHaveBeenCalledTimes(2);
    expect(dispatched).toEqual([
      "https://first.example.test/ping",
      "https://second.example.test/ping",
      "https://second.example.test/ping",
    ]);
  });
});

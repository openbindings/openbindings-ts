import { describe, it, expect, vi, afterEach } from "vitest";
import { AsyncAPIInvoker, AsyncAPISynthesizer } from "./invoker.js";
import { FORMAT_TOKEN, DEFAULT_SOURCE_NAME } from "./constants.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// prepareBinding is side-effect-free
// ---------------------------------------------------------------------------

describe("AsyncAPIInvoker.prepareBinding", () => {
  it("returns null with ZERO fetches when inline content carries an external $ref", async () => {
    let fetchCount = 0;
    const countingFetch = (async () => {
      fetchCount++;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    vi.stubGlobal("fetch", countingFetch);

    const spec = {
      asyncapi: "3.0.0",
      info: { title: "External refs", version: "1.0.0" },
      servers: { prod: { host: "api.example.com", protocol: "https" } },
      channels: {
        c: {
          address: "/c",
          messages: { M: { payload: { $ref: "https://schemas.example.com/m.json#/payload" } } },
        },
      },
      operations: {
        pub: {
          action: "send" as const,
          channel: { $ref: "#/channels/c" },
          security: [{ $ref: "https://schemas.example.com/security.json#/bearer" }],
        },
      },
    };

    const details = await new AsyncAPIInvoker().prepareBinding({
      source: { format: FORMAT_TOKEN, content: spec },
      ref: "#/operations/pub",
    });

    // The requirements are not knowable without I/O: report null, never fetch.
    expect(details).toBeNull();
    expect(fetchCount).toBe(0);
  });

  it("still reports requirements for fully inline content", async () => {
    let fetchCount = 0;
    vi.stubGlobal("fetch", (async () => {
      fetchCount++;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch);

    const spec = {
      asyncapi: "3.0.0",
      info: { title: "Inline", version: "1.0.0" },
      servers: { prod: { host: "api.example.com", protocol: "https" } },
      channels: { c: { address: "/c", messages: { M: { payload: { type: "object" } } } } },
      operations: {
        pub: {
          action: "send" as const,
          channel: { $ref: "#/channels/c" },
          security: [{ type: "http", scheme: "bearer" }],
        },
      },
    };

    const details = await new AsyncAPIInvoker().prepareBinding({
      source: { format: FORMAT_TOKEN, content: spec },
      ref: "#/operations/pub",
    });

    expect(details).toMatchObject({
      target: "https://api.example.com",
      alternatives: [{ requirements: [{ type: "auth.bearer" }] }],
    });
    expect(fetchCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Operation-layer no-input convention (send path)
// ---------------------------------------------------------------------------

describe("AsyncAPIInvoker no-input convention", () => {
  it("publishes one empty-object message when binding is set and inputSchema is absent", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: init?.body });
      return new Response(null, { status: 202 });
    }) as typeof globalThis.fetch;

    const spec = {
      asyncapi: "3.0.0",
      info: { title: "Notify", version: "1.0.0" },
      servers: { prod: { host: "api.example.com", protocol: "https" } },
      channels: { n: { address: "/notify", messages: { M: { payload: { type: "object" } } } } },
      operations: {
        notify: { action: "send" as const, channel: { $ref: "#/channels/n" } },
      },
    };

    // binding present + inputSchema absent: the operation declares NO input,
    // so the caller never writes nor closes — the call must not park on a
    // read nor fail ERR_MISSING_INPUT.
    const call = new AsyncAPIInvoker().invokeBinding({
      source: { format: FORMAT_TOKEN, content: spec },
      ref: "#/operations/notify",
      binding: { operation: "notify", source: "api", ref: "#/operations/notify" },
      fetch: fetchFn,
    });

    await expect(call.closed).resolves.toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.example.com/notify");
    expect(requests[0].body).toBe("{}");
  });
});

// ---------------------------------------------------------------------------
// Content-fed synthesis must embed the artifact so it stays invocable
// ---------------------------------------------------------------------------

// Per spec/formats/asyncapi.md: "A synthesized source carries the artifact
// (location, or embedded content when synthesized from content) so it
// stays invocable as written." Mirrors the Go SDK's
// TestSynthesizeInterface_ContentOnlyEmbedsSource.
describe("AsyncAPISynthesizer content-fed synthesis", () => {
  it("embeds the provided content verbatim when the source has no location", async () => {
    const content = '{"asyncapi":"3.0.0","info":{"title":"T","version":"1.0.0"},"operations":{}}';
    const iface = await new AsyncAPISynthesizer().synthesizeInterface({
      sources: [{ format: FORMAT_TOKEN, content }],
    });

    const src = iface.sources?.[DEFAULT_SOURCE_NAME];
    expect(src).toBeDefined();
    expect(src!.location).toBeUndefined();
    expect(src!.content).toBe(content);
  });

  it("does not embed content when the source has a location", async () => {
    const content = '{"asyncapi":"3.0.0","info":{"title":"T","version":"1.0.0"},"operations":{}}';

    const iface = await new AsyncAPISynthesizer().synthesizeInterface({
      sources: [{ format: FORMAT_TOKEN, location: "https://example.com/spec.json", content }],
    });

    const src = iface.sources?.[DEFAULT_SOURCE_NAME];
    expect(src?.location).toBe("https://example.com/spec.json");
    expect(src?.content).toBeUndefined();
  });
});

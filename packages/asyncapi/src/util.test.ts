import { describe, it, expect } from "vitest";
import {
  sanitizeKey,
  uniqueKey,
  parseSelector,
  parseAsyncAPIDocument,
} from "./util.js";

describe("sanitizeKey", () => {
  it("passes through clean keys", () => {
    expect(sanitizeKey("sendMessage")).toBe("sendMessage");
  });

  it("replaces special characters with underscores", () => {
    expect(sanitizeKey("send /messages/{id}")).toBe("send__messages__id");
  });

  it("strips leading and trailing underscores", () => {
    expect(sanitizeKey("__foo__")).toBe("foo");
  });

  it("returns 'unnamed' for empty result", () => {
    expect(sanitizeKey("!!!")).toBe("unnamed");
  });

  it("replaces an astral-plane character with one underscore, not one per surrogate half", () => {
    expect(sanitizeKey("t-😀-a")).toBe("t-_-a");
  });

  it("preserves dots and hyphens", () => {
    expect(sanitizeKey("events.receive-all")).toBe("events.receive-all");
  });

  it("prefixes keys that would start with a non-letter (OBI-D-03, Go parity)", () => {
    expect(sanitizeKey("2fa.enable")).toBe("_2fa.enable");
    expect(sanitizeKey(".hidden")).toBe("_.hidden");
    expect(sanitizeKey("-flag")).toBe("_-flag");
  });
});

describe("uniqueKey", () => {
  it("returns key directly when not used", () => {
    expect(uniqueKey("foo", new Set())).toBe("foo");
  });

  it("appends _2 on first collision", () => {
    expect(uniqueKey("foo", new Set(["foo"]))).toBe("foo_2");
  });

  it("increments until unique", () => {
    expect(uniqueKey("foo", new Set(["foo", "foo_2", "foo_3"]))).toBe("foo_4");
  });
});

describe("parseSelector", () => {
  it("extracts operation ID from #/operations/foo", () => {
    expect(parseSelector("#/operations/foo")).toBe("foo");
  });

  // ASYNC-D-03: the JSON Pointer `#/operations/<operation-key>` is the
  // ONLY conformant spelling — the former bare-key lenience is gone.
  it("refuses a bare operation key, citing the rule", () => {
    expect(() => parseSelector("sendMessage")).toThrow("ASYNC-D-03");
  });

  // ASYNC-D-03: an unescaped `/` after the prefix addresses a deeper path,
  // never an operations-map entry.
  it("refuses an unescaped / in the operation-key position", () => {
    expect(() => parseSelector("#/operations/tasks/create")).toThrow("ASYNC-D-03");
  });

  it("throws for empty selector", () => {
    expect(() => parseSelector("")).toThrow("ref is required");
  });

  it("throws for whitespace-only selector", () => {
    expect(() => parseSelector("   ")).toThrow("ref is required");
  });

  it("throws for empty operation ID after prefix", () => {
    expect(() => parseSelector("#/operations/")).toThrow("empty operation key");
  });

  // ASYNC-D-03: operation keys containing `/` or `~` carry RFC 6901
  // escaping in the pointer (~1 → /, ~0 → ~).
  it("unescapes RFC 6901 sequences in the operation key", () => {
    expect(parseSelector("#/operations/orders~1create~0v2")).toBe(
      "orders/create~v2",
    );
  });

  it("accepts an edition-native AsyncAPI 2.x operation pointer", () => {
    expect(parseSelector("#/channels/orders~1created/publish")).toBe(
      "v2:publish:orders/created",
    );
  });
});

describe("parseAsyncAPIDocument", () => {
  const validDoc = JSON.stringify({
    asyncapi: "3.0.0",
    info: { title: "Test", version: "1.0.0" },
    channels: {
      test: {
        address: "/test",
        messages: {
          TestMsg: { payload: { type: "object" } },
        },
      },
    },
    operations: {
      sendTest: {
        action: "send",
        channel: { $ref: "#/channels/test" },
        messages: [{ $ref: "#/channels/test/messages/TestMsg" }],
      },
    },
  });

  it("parses a valid JSON string", async () => {
    const doc = await parseAsyncAPIDocument(undefined, validDoc);
    expect(doc).toBeDefined();
    expect(doc.info.title).toBe("Test");
  });

  it("rejects an invalid document", async () => {
    await expect(
      parseAsyncAPIDocument(undefined, JSON.stringify({ not_asyncapi: true })),
    ).rejects.toThrow();
  });

  it("handles object content (not just string)", async () => {
    const obj = JSON.parse(validDoc);
    const doc = await parseAsyncAPIDocument(undefined, obj);
    expect(doc).toBeDefined();
    expect(doc.info.title).toBe("Test");
  });

  it("throws when neither location nor content is provided", async () => {
    await expect(parseAsyncAPIDocument()).rejects.toThrow(
      "source must have location or content",
    );
  });

  it("normalizes AsyncAPI 2.x perspective while preserving its native selector", async () => {
    const doc2x = JSON.stringify({
      asyncapi: "2.6.0",
      info: { title: "Legacy", version: "1.0.0" },
      servers: { broker: { url: "mqtt://broker.example", protocol: "mqtt" } },
      channels: {
        "messages/in": { publish: { message: { payload: { type: "object" } } } },
      },
    });
    const doc = await parseAsyncAPIDocument(undefined, doc2x);
    expect(doc.operations?.["v2:publish:messages/in"]?.action).toBe("receive");
    expect(parseSelector("#/channels/messages~1in/publish")).toBe("v2:publish:messages/in");
  });

  it("discriminates an unsupported edition before resolving external references", async () => {
    let fetches = 0;
    const fetchFn = (async () => {
      fetches += 1;
      throw new Error("must not fetch");
    }) as typeof globalThis.fetch;
    const unsupported = {
      asyncapi: "3.2.0",
      info: { title: "Future external schema", version: "1" },
      channels: {},
      components: {
        messages: {
          Event: { payload: { $ref: "https://schema.example.com/shared.json" } },
        },
      },
    };

    await expect(
      parseAsyncAPIDocument(undefined, unsupported, undefined, fetchFn),
    ).rejects.toThrow("ASYNC-P-01");
    expect(fetches).toBe(0);
  });

  it("accepts only the exact editions adopted by the @1 candidate", async () => {
    const doc = await parseAsyncAPIDocument(undefined, validDoc);
    expect(doc.asyncapi).toBe("3.0.0");
    await expect(
      parseAsyncAPIDocument(undefined, validDoc.replace("3.0.0", "3.0.17")),
    ).rejects.toThrow("ASYNC-P-01");
  });

  it("accepts 3.1.0 but refuses an unadopted 3.1 patch", async () => {
    await expect(
      parseAsyncAPIDocument(undefined, validDoc.replace("3.0.0", "3.1.0")),
    ).resolves.toBeDefined();
    await expect(
      parseAsyncAPIDocument(undefined, validDoc.replace("3.0.0", "3.1.2")),
    ).rejects.toThrow("ASYNC-P-01");
  });
});

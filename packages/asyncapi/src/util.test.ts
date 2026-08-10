import { describe, it, expect } from "vitest";
import {
  sanitizeKey,
  uniqueKey,
  parseRef,
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

describe("parseRef", () => {
  it("extracts operation ID from #/operations/foo", () => {
    expect(parseRef("#/operations/foo")).toBe("foo");
  });

  // ASYNC-D-03: the JSON Pointer `#/operations/<operation-key>` is the
  // ONLY conformant spelling — the former bare-key lenience is gone.
  it("refuses a bare operation key, citing the rule", () => {
    expect(() => parseRef("sendMessage")).toThrow("ASYNC-D-03");
  });

  // ASYNC-D-03: an unescaped `/` after the prefix addresses a deeper path,
  // never an operations-map entry.
  it("refuses an unescaped / in the operation-key position", () => {
    expect(() => parseRef("#/operations/tasks/create")).toThrow("ASYNC-D-03");
  });

  it("throws for empty ref", () => {
    expect(() => parseRef("")).toThrow("ref is required");
  });

  it("throws for whitespace-only ref", () => {
    expect(() => parseRef("   ")).toThrow("ref is required");
  });

  it("throws for empty operation ID after prefix", () => {
    expect(() => parseRef("#/operations/")).toThrow("empty operation key");
  });

  // ASYNC-D-03: operation keys containing `/` or `~` carry RFC 6901
  // escaping in the pointer (~1 → /, ~0 → ~).
  it("unescapes RFC 6901 sequences in the operation key", () => {
    expect(parseRef("#/operations/orders~1create~0v2")).toBe(
      "orders/create~v2",
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

  // ASYNC-P-01: the `asyncapi` field discriminates the accepted line —
  // AsyncAPI 2.x documents are out of the supported range and refused
  // loudly at load, never silently misparsed.
  it("refuses a 2.x document loudly instead of silently misparsing it", async () => {
    const doc2x = JSON.stringify({
      asyncapi: "2.6.0",
      info: { title: "Legacy", version: "1.0.0" },
      channels: {
        messages: { subscribe: { message: { payload: { type: "object" } } } },
      },
    });
    await expect(parseAsyncAPIDocument(undefined, doc2x)).rejects.toThrow(
      "ASYNC-P-01",
    );
  });

  it("discriminates an unsupported edition before resolving external references", async () => {
    let fetches = 0;
    const fetchFn = (async () => {
      fetches += 1;
      throw new Error("must not fetch");
    }) as typeof globalThis.fetch;
    const doc2x = {
      asyncapi: "2.0.0",
      info: { title: "Legacy external schema", version: "1" },
      channels: {},
      components: {
        messages: {
          Event: { payload: { $ref: "https://schema.example.com/shared.json" } },
        },
      },
    };

    await expect(
      parseAsyncAPIDocument(undefined, doc2x, undefined, fetchFn),
    ).rejects.toThrow("ASYNC-P-01");
    expect(fetches).toBe(0);
  });

  it("accepts exactly the artifact version adopted by revision 1", async () => {
    const doc = await parseAsyncAPIDocument(undefined, validDoc);
    expect(doc.asyncapi).toBe("3.0.0");
    await expect(
      parseAsyncAPIDocument(undefined, validDoc.replace("3.0.0", "3.0.17")),
    ).rejects.toThrow("ASYNC-P-01");
  });

  // ASYNC-P-01: accepting another edition requires a new binding-specification
  // identifier, never range inference.
  it("refuses a 3.1.x document: exactly 3.0.0, never sight-unseen 3.x", async () => {
    await expect(
      parseAsyncAPIDocument(undefined, validDoc.replace("3.0.0", "3.1.2")),
    ).rejects.toThrow("ASYNC-P-01");
  });
});

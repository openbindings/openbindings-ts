import { describe, it, expect } from "vitest";
import { sanitizeKey, uniqueKey, parseRef, parseAsyncAPIDocument } from "./util.js";

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

  it("preserves dots and hyphens", () => {
    expect(sanitizeKey("events.receive-all")).toBe("events.receive-all");
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

  it("returns bare ID as-is", () => {
    expect(parseRef("sendMessage")).toBe("sendMessage");
  });

  it("throws for empty ref", () => {
    expect(() => parseRef("")).toThrow("empty ref");
  });

  it("throws for whitespace-only ref", () => {
    expect(() => parseRef("   ")).toThrow("empty ref");
  });

  it("throws for empty operation ID after prefix", () => {
    expect(() => parseRef("#/operations/")).toThrow("empty operation ID");
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
    await expect(parseAsyncAPIDocument()).rejects.toThrow("source must have location or content");
  });
});

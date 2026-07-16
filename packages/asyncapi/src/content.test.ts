import { describe, expect, it } from "vitest";
import type { AsyncAPIDocument, AsyncAPIMessage, AsyncAPIOperation } from "./asyncapi-types.js";
import {
  decodeContentType,
  encodeInput,
  governingMessages,
  replyGoverningMessages,
  resolveInputCodec,
} from "./content.js";

// Unit coverage for the §9.1/§9.3 governing-set rules (ASYNC-P-03,
// ASYNC-P-05). Mirrors the Go SDK's util_test.go content additions.

function doc(defaultContentType?: string): AsyncAPIDocument {
  return {
    asyncapi: "3.0.0",
    info: { title: "t", version: "1" },
    ...(defaultContentType ? { defaultContentType } : {}),
  };
}

// AsyncAPI 3.0: a message that omits contentType takes the document's
// defaultContentType (the per-message EFFECTIVE content-type rule,
// ASYNC-P-05) — still the declared lane, never payload sniffing.
describe("effective content type falls back to the document default", () => {
  it("uses defaultContentType for an undeclared message; a per-message declaration wins", () => {
    const d = doc("application/json");
    const op: AsyncAPIOperation = { action: "send", messages: [{ name: "evt" }] };
    expect(decodeContentType(d, governingMessages(op, undefined))).toBe("application/json");

    op.messages = [{ name: "plain", contentType: "text/plain" }];
    expect(decodeContentType(d, governingMessages(op, undefined))).toBe("text/plain");
  });
});

// Direction-correct decode (ASYNC-P-05): a publish invocation's output (the
// response) decodes by the REPLY-side declarations, never the operation's
// own request-side messages.
describe("decode content type uses reply-side declarations", () => {
  it("collapses the reply set and the request set independently", () => {
    const d = doc();
    const op: AsyncAPIOperation = {
      action: "receive",
      messages: [{ name: "in", contentType: "text/plain" }],
      reply: { messages: [{ name: "out", contentType: "application/json" }] },
    };
    expect(decodeContentType(d, replyGoverningMessages(op))).toBe("application/json");
    expect(decodeContentType(d, governingMessages(op, undefined))).toBe("text/plain");
  });
});

// §9.3's conflict rule (ASYNC-P-05): a governing set resolving to MORE than
// one distinct effective content type is ambiguous, and decode falls to the
// text lane ("") rather than guessing — a mixed declared/undeclared set
// included.
describe("distinct effective types: ambiguity falls to the text lane", () => {
  it("two distinct types fall to the text lane", () => {
    const op: AsyncAPIOperation = {
      action: "send",
      messages: [
        { name: "a", contentType: "application/json" },
        { name: "b", contentType: "text/plain" },
      ],
    };
    expect(decodeContentType(doc(), governingMessages(op, undefined))).toBe("");
  });

  it("a charset parameter never makes a type distinct", () => {
    const op: AsyncAPIOperation = {
      action: "send",
      messages: [
        { name: "a", contentType: "application/json" },
        { name: "b", contentType: "application/json; charset=utf-8" },
      ],
    };
    expect(decodeContentType(doc(), governingMessages(op, undefined))).toBe("application/json");
  });

  it("a mixed declared/undeclared set is ambiguous, never collapsed onto the declared type", () => {
    const op: AsyncAPIOperation = {
      action: "send",
      messages: [{ name: "a", contentType: "application/json" }, { name: "b" }],
    };
    expect(decodeContentType(doc(), governingMessages(op, undefined))).toBe("");
  });
});

// The AsyncAPI rule: an operation that declares no `messages` supports ALL
// the channel's messages — the channel's set governs its lanes.
describe("governing messages: channel fallback", () => {
  it("falls back to all channel messages when the operation declares none", () => {
    const ch = {
      messages: {
        one: { name: "one", contentType: "application/json" },
        two: { name: "two", contentType: "application/json" },
      },
    };
    const op: AsyncAPIOperation = { action: "send" };
    const msgs = governingMessages(op, ch);
    expect(msgs).toHaveLength(2);
    expect(decodeContentType(doc(), msgs)).toBe("application/json");
  });
});

// §9.1 (ASYNC-P-03): JSON family → JSON; no declaration → JSON (the
// specification's default); text family → the raw text lane; ambiguity →
// the text lane; any other declared family is an @1 exclusion refused
// before dispatch.
describe("resolveInputCodec", () => {
  const mk = (...cts: string[]): AsyncAPIMessage[] =>
    cts.map((ct, i) => ({ name: String.fromCharCode(97 + i), contentType: ct }));

  it("selects JSON for a JSON-family declaration", () => {
    expect(resolveInputCodec(doc(), mk("application/json"))).toEqual({
      json: true,
      contentType: "application/json",
    });
  });

  it("selects JSON for no declaration at all (the spec default)", () => {
    expect(resolveInputCodec(doc(), [])).toEqual({
      json: true,
      contentType: "application/json",
    });
  });

  it("selects the text lane for a text-family declaration, sending strings raw and refusing non-strings", () => {
    const codec = resolveInputCodec(doc(), mk("text/plain"));
    expect(codec).toEqual({ json: false, contentType: "text/plain" });
    expect(encodeInput(codec, "raw text")).toBe("raw text");
    expect(() => encodeInput(codec, { not: "a string" })).toThrow(/must be a string/);
  });

  it("falls to the text lane for an ambiguous set, with no one declared type", () => {
    expect(resolveInputCodec(doc(), mk("application/json", "text/plain"))).toEqual({
      json: false,
      contentType: "",
    });
  });

  it("refuses excluded declared families before dispatch", () => {
    expect(() => resolveInputCodec(doc(), mk("avro/binary"))).toThrow(/excluded/);
    expect(() => resolveInputCodec(doc(), mk("application/octet-stream"))).toThrow(/excluded/);
  });
});

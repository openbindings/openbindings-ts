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

// Complete declared media identities are preserved. Several distinct
// identities cannot be collapsed without choosing for the artifact.
describe("distinct effective types: ambiguity is refused", () => {
  it("refuses two distinct types", () => {
    const op: AsyncAPIOperation = {
      action: "send",
      messages: [
        { name: "a", contentType: "application/json" },
        { name: "b", contentType: "text/plain" },
      ],
    };
    expect(() => decodeContentType(doc(), governingMessages(op, undefined))).toThrow(/conflicting/);
  });

  it("preserves parameters as part of the complete media identity", () => {
    const op: AsyncAPIOperation = {
      action: "send",
      messages: [
        { name: "a", contentType: "application/json" },
        { name: "b", contentType: "application/json; charset=utf-8" },
      ],
    };
    expect(() => decodeContentType(doc(), governingMessages(op, undefined))).toThrow(/conflicting/);
  });

  it("a mixed declared/undeclared set is ambiguous, never collapsed onto the declared type", () => {
    const op: AsyncAPIOperation = {
      action: "send",
      messages: [{ name: "a", contentType: "application/json" }, { name: "b" }],
    };
    expect(() => decodeContentType(doc(), governingMessages(op, undefined))).toThrow(/conflicting/);
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

// §9.1 (ASYNC-P-03): a declared JSON family selects JSON; every other
// declared media type carries string bytes. When the artifact declares no
// lane, configuration must choose one rather than the binding inventing it.
describe("resolveInputCodec", () => {
  const mk = (...cts: string[]): AsyncAPIMessage[] =>
    cts.map((ct, i) => ({ name: String.fromCharCode(97 + i), contentType: ct }));

  it("selects JSON for a JSON-family declaration", () => {
    expect(resolveInputCodec(doc(), mk("application/json"))).toEqual({
      json: true,
      contentType: "application/json",
    });
  });

  it("requires configuration when the selected message declares no lane", () => {
    const message = [{ name: "a" }];
    expect(() => resolveInputCodec(doc(), message)).toThrow(/configuration\.encode/);
    expect(resolveInputCodec(doc(), message, { configuration: { encode: "json" } })).toEqual({
      json: true,
      contentType: "application/json",
    });
    expect(resolveInputCodec(doc(), message, { configuration: { encode: "text" } })).toEqual({
      json: false,
      contentType: "text/plain; charset=utf-8",
    });
  });

  it("selects the text lane for a text-family declaration, sending strings raw and refusing non-strings", () => {
    const codec = resolveInputCodec(doc(), mk("text/plain"));
    expect(codec).toEqual({ json: false, contentType: "text/plain" });
    expect(encodeInput(codec, "raw text")).toBe("raw text");
    expect(() => encodeInput(codec, { not: "a string" })).toThrow(/must be a string/);
  });

  it("refuses an unselected set rather than choosing among artifact alternatives", () => {
    expect(() => resolveInputCodec(doc(), mk("application/json", "text/plain"))).toThrow(/exactly one selected message/);
  });

  it("refuses binary or codec-specific media rather than inventing string carriage", () => {
    expect(() => resolveInputCodec(doc(), mk("application/avro"))).toThrow(/no candidate application-value carriage/);
  });

  it("refuses a declared non-UTF-8 text charset", () => {
    expect(() => resolveInputCodec(doc(), mk("text/plain; charset=iso-8859-1"))).toThrow(/non-UTF-8 charset/);
  });
});

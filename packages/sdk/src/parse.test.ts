import { describe, expect, it } from "vitest";
import { parseDocument, validateDocument, formatValidationErrors } from "./parse.js";
import { ValidationError } from "./errors.js";

describe("parseDocument", () => {
  it("parses and validates a raw OBI document", () => {
    const iface = parseDocument(`{"openbindings":"0.2.0","operations":{}}`);
    expect(iface.openbindings).toBe("0.2.0");
  });

  it.each([
    [
      "top-level duplicate",
      `{"openbindings":"0.2.0","operations":{},"operations":{}}`,
    ],
    [
      "nested duplicate",
      `{"openbindings":"0.2.0","operations":{"op":{"input":{"type":"string","type":"number"}}}}`,
    ],
    [
      "escaped duplicate",
      `{"openbindings":"0.2.0","operations":{"op":{"input":{"a":1,"\\u0061":2}}}}`,
    ],
  ])("rejects duplicate object keys: %s", (_name, doc) => {
    expect(() => parseDocument(doc)).toThrow("duplicate object key");
  });

  it("rejects a document that fails the meta-schema (OBI-D-02)", () => {
    // `operations` is required by the meta-schema; the bare `{"openbindings": ...}`
    // shape passes neither parseDocument nor the previous shape check.
    expect(() => parseDocument(`{"openbindings":"0.2.0"}`)).toThrow(ValidationError);
  });

  it("rejects a document with an invalid `openbindings` SemVer (OBI-D-13 via meta-schema)", () => {
    expect(() => parseDocument(`{"openbindings":"not-a-version","operations":{}}`))
      .toThrow(ValidationError);
  });

  it("rejects invalid UTF-8 byte input (OBI-D-01)", () => {
    // 0xFF can never appear in valid UTF-8; the default non-fatal
    // TextDecoder would silently replace it with U+FFFD.
    const prefix = new TextEncoder().encode(`{"openbindings":"0.2.0","name":"X`);
    const suffix = new TextEncoder().encode(`","operations":{}}`);
    const bytes = new Uint8Array(prefix.length + 2 + suffix.length);
    bytes.set(prefix, 0);
    bytes.set([0xff, 0xfe], prefix.length);
    bytes.set(suffix, prefix.length + 2);
    expect(() => parseDocument(bytes)).toThrow(/UTF-8/);
  });

  it("accepts valid UTF-8 byte input", () => {
    const bytes = new TextEncoder().encode(`{"openbindings":"0.2.0","name":"héllo","operations":{}}`);
    expect(parseDocument(bytes).name).toBe("héllo");
  });
});

describe("validateDocument", () => {
  it("returns the parsed interface when both parse and rule-walk succeed", () => {
    const iface = validateDocument(`{"openbindings":"0.2.0","operations":{}}`);
    expect(iface.openbindings).toBe("0.2.0");
  });

  it("throws on parse-time failure (delegates to parseDocument)", () => {
    expect(() => validateDocument(`{"openbindings":"0.2.0"}`)).toThrow(ValidationError);
  });

  it("throws on rule-walk failure (delegates to validateInterface)", () => {
    // Future-major version: parseDocument accepts it (meta-schema only checks
    // SemVer shape), validateInterface rejects it via OBI-T-04.
    expect(() => validateDocument(`{"openbindings":"99.0.0","operations":{}}`))
      .toThrow(/OBI-T-04/);
  });
});

describe("formatValidationErrors", () => {
  it("joins ValidationError problems with newlines", () => {
    const err = new ValidationError(["one", "two", "three"]);
    expect(formatValidationErrors(err)).toBe("one\ntwo\nthree");
  });

  it("returns Error.message for non-ValidationError errors", () => {
    expect(formatValidationErrors(new Error("boom"))).toBe("boom");
  });

  it("string-coerces other values", () => {
    expect(formatValidationErrors("just a string")).toBe("just a string");
  });
});

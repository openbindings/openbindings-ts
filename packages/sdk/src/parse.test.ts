import { describe, expect, it } from "vitest";
import { parseDocument } from "./parse.js";

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
});

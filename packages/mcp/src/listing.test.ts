import { describe, it, expect } from "vitest";
import { ERR_REF_NOT_FOUND, InvocationError } from "@openbindings/sdk";
import { parsePinnedListing, resolveRef, type Listing } from "./listing.js";

describe("parsePinnedListing (MCP-D-01)", () => {
  it("parses a full pinned listing into entity identities, in order", () => {
    const l = parsePinnedListing({
      tools: [{ name: "a" }, { name: "b", description: "extra members of the entity shape are fine" }],
      resources: [{ uri: "app://x", name: "x" }],
      resourceTemplates: [{ uriTemplate: "file:///logs/{date}", name: "logs" }],
      prompts: [{ name: "greet" }],
    });
    expect(l.tools).toEqual(["a", "b"]);
    expect(l.resources).toEqual(["app://x"]);
    expect(l.templates).toEqual(["file:///logs/{date}"]);
    expect(l.prompts).toEqual(["greet"]);
    expect(l.pinned).toBe(true);
  });

  it("accepts every member as optional (an empty pin is a valid, empty listing)", () => {
    const l = parsePinnedListing({});
    expect(l.tools).toEqual([]);
    expect(l.resources).toEqual([]);
    expect(l.templates).toEqual([]);
    expect(l.prompts).toEqual([]);
  });

  it("treats a null member as an empty entity array (Go parity: json null unmarshals to an empty slice)", () => {
    const l = parsePinnedListing({ tools: null });
    expect(l.tools).toEqual([]);
  });

  it.each([
    ["stray nextCursor", { tools: [], nextCursor: "p2" }, /nextCursor/],
    ["stray _meta", { tools: [], _meta: {} }, /_meta/],
    ["arbitrary stray member", { extras: [] }, /"extras"/],
    ["non-object content", "nope", /pinned-listing object/],
    ["array content", [], /pinned-listing object/],
    ["null content", null, /pinned-listing object/],
    ["member not an array", { tools: { name: "x" } }, /must be an entity array/],
    ["entry not an object", { tools: ["x"] }, /tools\[0\] must be an object/],
    ["entry missing identity", { prompts: [{ description: "d" }] }, /string "name"/],
    ["entry identity not a string", { resources: [{ uri: 7 }] }, /string "uri"/],
  ])("refuses %s loudly with an MCP-D-01 message", (_name, content, wantMessage) => {
    expect(() => parsePinnedListing(content)).toThrow(wantMessage);
    expect(() => parsePinnedListing(content)).toThrow(/MCP-D-01/);
  });

  it("names the sorted first offender when several stray members are present (deterministic refusal)", () => {
    expect(() => parsePinnedListing({ zz: 1, _meta: {}, nextCursor: "x" })).toThrow(/"_meta"/);
  });
});

describe("resolveRef (§7, MCP-D-03, MCP-P-02)", () => {
  const listing = (partial: Partial<Listing>, pinned = true): Listing => ({
    tools: [],
    resources: [],
    templates: [],
    prompts: [],
    pinned,
    ...partial,
  });

  it("resolves each entity family to its target kind", () => {
    expect(resolveRef(listing({ tools: ["t"] }), "tools", "t")).toBe("tool");
    expect(resolveRef(listing({ prompts: ["p"] }), "prompts", "p")).toBe("prompt");
    expect(resolveRef(listing({ resources: ["app://x"] }), "resources", "app://x")).toBe("staticResource");
    expect(resolveRef(listing({ templates: ["app://{id}"] }), "resources", "app://{id}")).toBe("templateResource");
  });

  it("matches byte-exactly, never by prefix, case fold, or template match", () => {
    // A template is addressed by its template string, byte-exact — never
    // by a URI that the template happens to match (§7).
    const l = listing({ templates: ["file:///x/{id}"] });
    expect(() => resolveRef(l, "resources", "file:///x/42")).toThrow(/matches no/);
    expect(() => resolveRef(listing({ tools: ["Tool"] }), "tools", "tool")).toThrow(/matches no/);
    expect(() => resolveRef(listing({ tools: ["tool"] }), "tools", "too")).toThrow(/matches no/);
  });

  it("matches resources before templates when both carry the same identity", () => {
    // §7: a resources remainder matches first against declared resource
    // URIs, then against template strings.
    const l = listing({ resources: ["file:///x/{id}"], templates: ["file:///x/{id}"] });
    expect(resolveRef(l, "resources", "file:///x/{id}")).toBe("staticResource");
  });

  it("refuses an ambiguous match loudly, never first-match", () => {
    for (const [l, entity, remainder, what] of [
      [listing({ tools: ["dup", "dup"] }), "tools", "dup", "2 tools"],
      [listing({ prompts: ["dup", "dup", "dup"] }), "prompts", "dup", "3 prompts"],
      [listing({ resources: ["app://d", "app://d"] }), "resources", "app://d", "2 resources"],
      [listing({ templates: ["a{v}", "a{v}"] }), "resources", "a{v}", "2 resource templates"],
    ] as const) {
      let thrown: unknown;
      try {
        resolveRef(l, entity, remainder);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(InvocationError);
      expect((thrown as InvocationError).code).toBe(ERR_REF_NOT_FOUND);
      expect((thrown as InvocationError).message).toContain("ambiguous");
      expect((thrown as InvocationError).message).toContain(what);
    }
  });

  it("names the listing kind in refusals (pinned vs server)", () => {
    expect(() => resolveRef(listing({}, true), "tools", "x")).toThrow(/pinned listing/);
    expect(() => resolveRef(listing({}, false), "tools", "x")).toThrow(/server listing/);
  });
});

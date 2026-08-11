import { describe, expect, it } from "vitest";
import { ERR_REF_NOT_FOUND, type InvocationError } from "@openbindings/sdk";
import { parsePinnedListing, resolveRef, type Listing } from "./listing.js";

function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    tools: [],
    requiredTaskTools: [],
    toolOutputSchemas: {},
    resources: [],
    templates: [],
    prompts: [],
    pinned: true,
    ...overrides,
  };
}

describe("openbindings.mcp@1 listing resolution", () => {
  it("resolves exactly one ordinary tool with an application output schema", () => {
    expect(resolveRef(listing({
      tools: ["weather"],
      toolOutputSchemas: { weather: { type: "object" } },
    }), "tools", "weather")).toBe("tool");
  });

  it.each([
    ["missing identity", listing({ tools: ["weather"], toolOutputSchemas: { weather: {} } }), "tools", "missing", /matches no/],
    ["ambiguous identity", listing({ tools: ["weather", "weather"], toolOutputSchemas: { weather: {} } }), "tools", "weather", /ambiguous/],
    ["missing outputSchema", listing({ tools: ["weather"] }), "tools", "weather", /no outputSchema/],
    ["required task", listing({ tools: ["weather"], requiredTaskTools: ["weather"], toolOutputSchemas: { weather: {} } }), "tools", "weather", /task augmentation/],
    ["resource", listing({ resources: ["app://x"] }), "resources", "app://x", /excluded/],
    ["resource template", listing({ templates: ["app://{id}"] }), "resourceTemplates", "app://{id}", /excluded/],
    ["prompt", listing({ prompts: ["review"] }), "prompts", "review", /excluded/],
  ])("refuses %s", (_name, inventory, family, identity, message) => {
    let thrown: InvocationError | undefined;
    try {
      resolveRef(inventory, family, identity);
    } catch (error) {
      thrown = error as InvocationError;
    }
    expect(thrown).toMatchObject({ code: ERR_REF_NOT_FOUND });
    expect(thrown?.message).toMatch(message);
  });
});

describe("pinned listing grammar", () => {
  it("retains output schemas and required-task declarations", () => {
    expect(parsePinnedListing({
      tools: [
        { name: "ordinary", outputSchema: { type: "object" } },
        { name: "task", outputSchema: {}, execution: { taskSupport: "required" } },
      ],
      resources: [{ uri: "app://x" }],
      resourceTemplates: [{ uriTemplate: "app://{id}" }],
      prompts: [{ name: "review" }],
    })).toMatchObject({
      tools: ["ordinary", "task"],
      requiredTaskTools: ["task"],
      toolOutputSchemas: { ordinary: { type: "object" }, task: {} },
      resources: ["app://x"],
      templates: ["app://{id}"],
      prompts: ["review"],
      pinned: true,
    });
  });

  it.each([
    null,
    [],
    { nextCursor: "later" },
    { tools: {} },
    { tools: [{ description: "missing identity" }] },
  ])("rejects invalid source content %#", (content) => {
    expect(() => parsePinnedListing(content)).toThrow(/pinned|listing|member|identity|name/);
  });
});

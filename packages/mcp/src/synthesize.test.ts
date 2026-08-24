import { describe, expect, it } from "vitest";
import { BINDING_SPEC } from "./constants.js";
import { bindableDiscovery, convertToInterface, type MCPDiscovery } from "./synthesize.js";

function discovery(overrides: Partial<MCPDiscovery> = {}): MCPDiscovery {
  return {
    tools: [],
    resources: [],
    resourceTemplates: [],
    prompts: [],
    ...overrides,
  };
}

describe("openbindings.mcp@1 synthesis", () => {
  it("projects only eligible tools and uses outputSchema as the complete application output", () => {
    const outputSchema = {
      type: "object",
      properties: { temperature: { type: "number" } },
      required: ["temperature"],
    };
    const iface = convertToInterface(discovery({
      serverName: "weather",
      serverVersion: "1.0.0",
      tools: [
        { name: "get weather", description: "Get weather", inputSchema: { type: "object" }, outputSchema },
        { name: "legacy", inputSchema: { type: "object" } },
        { name: "task", outputSchema: {}, taskSupport: "required" },
      ],
      resources: [{ name: "config", uri: "app://config" }],
      prompts: [{ name: "review" }],
    }), "https://mcp.example.test", BINDING_SPEC);

    expect(Object.keys(iface.operations)).toEqual(["get_weather"]);
    expect(iface.operations.get_weather).toEqual({
      description: "Get weather",
      input: { type: "object" },
      output: outputSchema,
    });
    expect(iface.bindings?.["get_weather.mcpServer"]?.selector).toBe("tools/get weather");
    expect(iface.sources?.mcpServer).toEqual({
      bindingSpec: BINDING_SPEC,
      location: "https://mcp.example.test",
    });
  });

  it("keeps deterministic key ordering and collision resolution among eligible tools", () => {
    const iface = convertToInterface(discovery({ tools: [
      { name: "a b", outputSchema: {} },
      { name: "a_b", outputSchema: {} },
      { name: "2fa", outputSchema: {} },
    ] }));
    expect(Object.keys(iface.operations)).toEqual(["_2fa", "a_b", "tool_a_b"]);
  });

  it("filters ambiguous, missing-contract, task-required, and non-tool inventory", () => {
    const filtered = bindableDiscovery(discovery({
      tools: [
        { name: "ok", outputSchema: {} },
        { name: "missing" },
        { name: "dup", outputSchema: {} },
        { name: "dup", outputSchema: {} },
        { name: "task", outputSchema: {}, taskSupport: "required" },
      ],
      resources: [{ name: "resource", uri: "app://x" }],
      resourceTemplates: [{ name: "template", uriTemplate: "app://{id}" }],
      prompts: [{ name: "prompt" }],
    }));
    expect(filtered.tools.map((tool) => tool.name)).toEqual(["ok"]);
    expect(filtered.resources).toEqual([]);
    expect(filtered.resourceTemplates).toEqual([]);
    expect(filtered.prompts).toEqual([]);
  });
});

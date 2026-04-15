import { describe, it, expect } from "vitest";
import { convertToInterface } from "./create.js";

describe("convertToInterface", () => {
  it("converts tools to operations", () => {
    const iface = convertToInterface({
      serverName: "test-server",
      serverVersion: "1.0.0",
      tools: [
        {
          name: "get_weather",
          description: "Get weather for a city",
          inputSchema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
      resources: [],
      resourceTemplates: [],
      prompts: [],
    }, "https://mcp.example.com");

    expect(iface.name).toBe("test-server");
    expect(iface.version).toBe("1.0.0");
    expect(Object.keys(iface.operations)).toEqual(["get_weather"]);
    expect(iface.operations.get_weather.description).toBe("Get weather for a city");
    expect(iface.operations.get_weather.input).toBeDefined();

    const binding = iface.bindings!["get_weather.mcpServer"];
    expect(binding.ref).toBe("tools/get_weather");
    expect(binding.source).toBe("mcpServer");
  });

  it("converts resources with const URI", () => {
    const iface = convertToInterface({
      tools: [],
      resources: [
        { name: "config", uri: "file:///etc/config.json", description: "Config file" },
      ],
      resourceTemplates: [],
      prompts: [],
    });

    const op = iface.operations.config;
    expect(op.description).toBe("Config file");
    expect((op.input as Record<string, unknown>)?.properties).toHaveProperty("uri");

    const binding = iface.bindings!["config.mcpServer"];
    expect(binding.ref).toBe("resources/file:///etc/config.json");
  });

  it("converts prompts with arguments", () => {
    const iface = convertToInterface({
      tools: [],
      resources: [],
      resourceTemplates: [],
      prompts: [
        {
          name: "summarize",
          description: "Summarize text",
          arguments: [
            { name: "text", description: "Text to summarize", required: true },
            { name: "style", description: "Summary style" },
          ],
        },
      ],
    });

    const op = iface.operations.summarize;
    expect(op.description).toBe("Summarize text");

    const input = op.input as Record<string, unknown>;
    expect(input.type).toBe("object");
    expect(input.required).toEqual(["text"]);

    expect(op.output).toBeDefined();

    const binding = iface.bindings!["summarize.mcpServer"];
    expect(binding.ref).toBe("prompts/summarize");
  });

  it("handles key collisions", () => {
    const iface = convertToInterface({
      tools: [{ name: "fetch" }],
      resources: [{ name: "fetch", uri: "data://fetch" }],
      resourceTemplates: [],
      prompts: [],
    });

    expect(Object.keys(iface.operations)).toHaveLength(2);
    expect(iface.operations.fetch).toBeDefined();
    expect(iface.operations.resource_fetch).toBeDefined();
  });

  it("sorts entities alphabetically", () => {
    const iface = convertToInterface({
      tools: [
        { name: "zebra" },
        { name: "alpha" },
        { name: "middle" },
      ],
      resources: [],
      resourceTemplates: [],
      prompts: [],
    });

    const keys = Object.keys(iface.operations);
    expect(keys).toEqual(["alpha", "middle", "zebra"]);
  });
});

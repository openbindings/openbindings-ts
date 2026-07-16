import { describe, it, expect } from "vitest";
import { convertToInterface } from "./synthesize.js";

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

  it("static resources declare no input (openbindings.mcp@1 §8/§9.1)", () => {
    // Updated for openbindings.mcp@1: this test previously pinned a
    // const-uri input schema, an input the conformant invoker refuses. The
    // URI is the binding's ref, not caller input.
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
    expect(op.input).toBeUndefined();

    const binding = iface.bindings!["config.mcpServer"];
    expect(binding.ref).toBe("resources/file:///etc/config.json");
  });

  it("resource templates declare their RFC 6570 variables as input (§8/§9.1, MCP-P-03)", () => {
    // Updated for openbindings.mcp@1: a template operation's input is the
    // object of its RFC 6570 variables (string-typed, none required) —
    // this test previously pinned a const-uriTemplate input schema, whose
    // only member the conformant invoker refuses as an undeclared variable.
    const iface = convertToInterface({
      tools: [],
      resources: [],
      resourceTemplates: [
        { name: "user_profile", uriTemplate: "users/{userId}/profile" },
      ],
      prompts: [],
    });

    const op = iface.operations.user_profile;
    const input = op.input as Record<string, unknown>;
    expect(input).toBeDefined();

    const props = input.properties as Record<string, unknown>;
    const varSchema = props.userId as Record<string, unknown>;
    expect(varSchema).toBeDefined();
    // Template variables are string-typed (never coerced).
    expect(varSchema.type).toBe("string");
    // uriTemplate must not appear as an input property.
    expect(props).not.toHaveProperty("uriTemplate");
    // Undeclared variables are refused, hence additionalProperties: false.
    expect(input.additionalProperties).toBe(false);
    // No variable is required: unsupplied variables follow RFC 6570
    // undefined-value expansion.
    expect(input).not.toHaveProperty("required");

    const binding = iface.bindings!["user_profile.mcpServer"];
    expect(binding.ref).toBe("resources/users/{userId}/profile");
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

  it("prompt output schema requires messages and describes each message's shape (Go parity)", () => {
    // The convention record's Invocation shape section states prompts
    // output "{messages, description?}" -- messages required, description
    // optional. Go's promptOutputSchema() (synthesize.go) matches that:
    // required:[messages] plus an items schema describing role/content.
    // TS's inline schema had no `required` at all (contradicting the
    // record's own "messages, description?" shape) and no items schema.
    const iface = convertToInterface({
      tools: [],
      resources: [],
      resourceTemplates: [],
      prompts: [{ name: "review", description: "Review code" }],
    });

    const output = iface.operations.review.output as Record<string, unknown>;
    expect(output.type).toBe("object");
    expect(output.required).toEqual(["messages"]);

    const properties = output.properties as Record<string, unknown>;
    expect(properties.messages).toBeDefined();
    const messages = properties.messages as Record<string, unknown>;
    expect(messages.type).toBe("array");

    const items = messages.items as Record<string, unknown>;
    expect(items.type).toBe("object");
    expect(items.required).toEqual(["role", "content"]);
    const itemProps = items.properties as Record<string, unknown>;
    expect(itemProps.role).toBeDefined();
    expect(itemProps.content).toBeDefined();
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

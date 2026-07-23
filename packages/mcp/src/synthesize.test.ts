import { describe, it, expect } from "vitest";
import { codePointCompare, convertToInterface, sanitizeKey } from "./synthesize.js";

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
    expect(iface.operations.get_weather?.description).toBe("Get weather for a city");
    expect(iface.operations.get_weather?.input).toBeDefined();

    const binding = iface.bindings!["get_weather.mcpServer"];
    if (!binding) throw new Error("missing binding: get_weather.mcpServer");
    expect(binding.ref).toBe("tools/get_weather");
    expect(binding.source).toBe("mcpServer");
  });

  it("prefixes digit-leading tool names to a valid key (OBI-D-03, Go parity)", () => {
    const iface = convertToInterface({
      tools: [
        { name: "2fa-check", inputSchema: { type: "object", properties: {} } },
      ],
      resources: [],
      resourceTemplates: [],
      prompts: [],
    });

    expect(Object.keys(iface.operations)).toEqual(["_2fa-check"]);
    expect(iface.bindings!["_2fa-check.mcpServer"]?.ref).toBe("tools/2fa-check");
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
    if (!op) throw new Error("missing operation: config");
    expect(op.description).toBe("Config file");
    expect(op.input).toBeUndefined();

    const binding = iface.bindings!["config.mcpServer"];
    if (!binding) throw new Error("missing binding: config.mcpServer");
    expect(binding.ref).toBe("resources/file:///etc/config.json");
  });

  it("resource templates declare their RFC 6570 variables as input (§8/§9.1, MCP-P-03)", () => {
    // Updated for openbindings.mcp@1: a template operation's input is the
    // object of its RFC 6570 variables (string/list/associative, none
    // required) —
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
    if (!op) throw new Error("missing operation: user_profile");
    const input = op.input as Record<string, unknown>;
    expect(input).toBeDefined();

    const props = input.properties as Record<string, unknown>;
    const varSchema = props.userId as Record<string, unknown>;
    expect(varSchema).toBeDefined();
    // Preserve RFC 6570's complete variable value domain.
    expect(varSchema.anyOf).toEqual([
      { type: "string" },
      { type: "array", items: { type: "string" } },
      { type: "object", additionalProperties: { type: "string" } },
    ]);
    // uriTemplate must not appear as an input property.
    expect(props).not.toHaveProperty("uriTemplate");
    // Undeclared variables are refused, hence additionalProperties: false.
    expect(input.additionalProperties).toBe(false);
    // No variable is required: unsupplied variables follow RFC 6570
    // undefined-value expansion.
    expect(input).not.toHaveProperty("required");

    const binding = iface.bindings!["user_profile.mcpServer"];
    if (!binding) throw new Error("missing binding: user_profile.mcpServer");
    expect(binding.ref).toBe("resourceTemplates/users/{userId}/profile");
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
    if (!op) throw new Error("missing operation: summarize");
    expect(op.description).toBe("Summarize text");

    const input = op.input as Record<string, unknown>;
    expect(input.type).toBe("object");
    expect(input.required).toEqual(["text"]);

    expect(op.output).toBeDefined();

    const binding = iface.bindings!["summarize.mcpServer"];
    if (!binding) throw new Error("missing binding: summarize.mcpServer");
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

    const reviewOp = iface.operations.review;
    if (!reviewOp) throw new Error("missing operation: review");
    const output = reviewOp.output as Record<string, unknown>;
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

  it("orders mixed-case names by code point, not locale collation", () => {
    const iface = convertToInterface({
      tools: [{ name: "alpha_tool" }, { name: "Bravo_tool" }],
      resources: [],
      resourceTemplates: [],
      prompts: [],
    });

    // "B" (U+0042) < "a" (U+0061) by code point; ICU locale collation
    // (the localeCompare this replaces) would flip the pair.
    expect(Object.keys(iface.operations)).toEqual(["Bravo_tool", "alpha_tool"]);
  });

  it("orders astral-plane names by code point, not UTF-16 code unit", () => {
    // "ﬁ" (U+FB01) < "😀" (U+1F600) by code point — the order Go's byte-wise
    // comparison produces — while by UTF-16 code unit the surrogate half
    // 0xD83D would sort the emoji first.
    const iface = convertToInterface({
      tools: [{ name: "t-😀-a" }, { name: "t-ﬁ-b" }],
      resources: [],
      resourceTemplates: [],
      prompts: [],
    });

    // Each non-key character sanitizes to ONE underscore (u-flag regex),
    // matching Go's rune-wise SanitizeKey.
    expect(Object.keys(iface.operations)).toEqual(["t-_-b", "t-_-a"]);
  });

  it("resolves sanitized-key collisions in code point order of the raw names", () => {
    // Both names sanitize to "a_b". " " (U+0020) < "_" (U+005F), so the
    // space-named tool is processed first and wins the bare key; the
    // underscore-named tool takes the entity-type prefix. ICU collation
    // weighs punctuation variably, so before codePointCompare this
    // assignment depended on the host locale.
    const iface = convertToInterface({
      tools: [
        { name: "a_b", description: "underscore tool" },
        { name: "a b", description: "space tool" },
      ],
      resources: [],
      resourceTemplates: [],
      prompts: [],
    });

    expect(iface.operations["a_b"]?.description).toBe("space tool");
    expect(iface.operations["tool_a_b"]?.description).toBe("underscore tool");
  });
});

describe("codePointCompare", () => {
  it("matches Go's byte-wise string ordering", () => {
    expect(codePointCompare("Ping", "add")).toBeLessThan(0); // 0x50 < 0x61
    expect(codePointCompare("ﬁ", "😀")).toBeLessThan(0); // U+FB01 < U+1F600
    expect("😀" < "ﬁ").toBe(true); // the UTF-16 code-unit trap this replaces
    expect(codePointCompare("a", "ab")).toBeLessThan(0); // shared prefix: shorter first
    expect(codePointCompare("same", "same")).toBe(0);
    expect(codePointCompare("b", "a")).toBeGreaterThan(0);
  });
});

describe("sanitizeKey", () => {
  it("replaces an astral-plane character with one underscore, not one per surrogate half", () => {
    expect(sanitizeKey("t-😀-a")).toBe("t-_-a");
  });
});

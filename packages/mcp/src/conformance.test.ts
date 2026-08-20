import { describe, expect, it } from "vitest";
import {
  ERR_REF_NOT_FOUND,
  ERR_SOURCE_LOAD_FAILED,
  single,
  type Invocation,
  type InvocationError,
} from "@openbindings/invoke";
import { BINDING_SPEC } from "./constants.js";
import { MCPInvoker } from "./invoker.js";
import { ENDPOINT, mcpServer, type MCPServerOptions, type RpcRequest, type RpcReply } from "./testserver.js";

const source = { bindingSpec: BINDING_SPEC, location: ENDPOINT };

async function drain(call: Invocation<unknown, unknown>): Promise<{ values: unknown[]; error?: InvocationError }> {
  const values: unknown[] = [];
  try {
    for await (const value of call.outputs) values.push(value);
    return { values };
  } catch (error) {
    return { values, error: error as InvocationError };
  }
}

function server(options: Partial<MCPServerOptions> = {}) {
  const respond = (request: RpcRequest): RpcReply => {
    if (request.method === "tools/call") {
      return {
        result: {
          content: [{ type: "text", text: "native shadow" }],
          structuredContent: { value: String(request.params.name) },
        },
      };
    }
    return { error: { code: -32601, message: `unexpected ${request.method}` } };
  };
  return mcpServer(respond, { tools: ["probe", "last"], resources: ["app://x"], prompts: ["review"], ...options });
}

describe("openbindings.mcp@1 pinned artifact conformance", () => {
  it.each([
    ["non-object", "not a listing"],
    ["array", []],
    ["pagination carriage", { nextCursor: "later" }],
    ["non-array family", { tools: {} }],
    ["missing identity", { tools: [{ outputSchema: {} }] }],
  ])("refuses invalid pinned content before I/O: %s", async (_name, content) => {
    const fixture = server();
    const call = new MCPInvoker().invokeBinding({ source: { ...source, content }, ref: "tools/probe", fetch: fixture.fn });
    const result = await drain(call);
    expect(result.values).toEqual([]);
    expect(result.error).toMatchObject({ code: ERR_SOURCE_LOAD_FAILED });
    expect(fixture.fetches()).toBe(0);
  });

  it("lets the pin answer resolution and never consults live listings", async () => {
    const fixture = server();
    const content = { tools: [{ name: "probe", inputSchema: { type: "object" }, outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }] };
    const call = new MCPInvoker().invokeBinding({ source: { ...source, content }, ref: "tools/probe", fetch: fixture.fn });
    await call.write({ q: 1 });
    await expect(single(call.outputs)).resolves.toEqual({ value: "probe" });
    expect(fixture.count("tools/list")).toBe(0);
    expect(fixture.count("tools/call")).toBe(1);
  });

  it.each([
    ["missing", { tools: [{ name: "probe", outputSchema: {} }] }, "tools/missing"],
    ["ambiguous", { tools: [{ name: "probe", outputSchema: {} }, { name: "probe", outputSchema: {} }] }, "tools/probe"],
    ["missing application contract", { tools: [{ name: "probe" }] }, "tools/probe"],
    ["resource inventory", { resources: [{ uri: "app://x" }] }, "resources/app://x"],
  ])("refuses %s offline", async (_name, content, ref) => {
    const fixture = server();
    const call = new MCPInvoker().invokeBinding({ source: { ...source, content }, ref, fetch: fixture.fn });
    await expect(call.closed).rejects.toMatchObject({ code: ERR_REF_NOT_FOUND });
    expect(fixture.fetches()).toBe(0);
  });
});

describe("openbindings.mcp@1 live artifact conformance", () => {
  it("follows listing pagination to exhaustion before resolving", async () => {
    const fixture = server({ pageSize: 1 });
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/last", fetch: fixture.fn });
    await call.write({});
    await expect(single(call.outputs)).resolves.toEqual({ value: "last" });
    expect(fixture.count("tools/list")).toBe(2);
  });

  it("omits an absent arguments member", async () => {
    const fixture = server();
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/probe", fetch: fixture.fn });
    await call.close();
    await expect(single(call.outputs)).resolves.toEqual({ value: "probe" });
    expect(fixture.params("tools/call")[0]).not.toHaveProperty("arguments");
  });

  it("does not turn progress solicitation configuration into an output lane", async () => {
    const fixture = server();
    const call = new MCPInvoker({ solicitProgress: true }).invokeBinding({
      source,
      ref: "tools/probe",
      context: { configuration: { solicit: true } },
      fetch: fixture.fn,
    });
    await call.write({});
    await expect(single(call.outputs)).resolves.toEqual({ value: "probe" });
    expect(fixture.params("tools/call")[0]).not.toHaveProperty("_meta");
  });

  it("keeps resources and prompts in inventory but excludes them as operations", async () => {
    const fixture = server();
    const resource = new MCPInvoker().invokeBinding({ source, ref: "resources/app://x", fetch: fixture.fn });
    await expect(resource.closed).rejects.toMatchObject({ code: ERR_REF_NOT_FOUND });
    expect(fixture.count("resources/read")).toBe(0);

    const prompt = new MCPInvoker().invokeBinding({ source, ref: "prompts/review", fetch: fixture.fn });
    await prompt.close();
    await expect(prompt.closed).rejects.toMatchObject({ code: ERR_REF_NOT_FOUND });
    expect(fixture.count("prompts/get")).toBe(0);
  });
});

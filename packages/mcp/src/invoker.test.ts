import { describe, expect, it } from "vitest";
import {
  ERR_CANCELLED,
  ERR_EXECUTION_FAILED,
  ERR_REF_NOT_FOUND,
  ERR_RESPONSE_ERROR,
  ERR_SOURCE_CONFIG_ERROR,
  ERR_VALIDATION_FAILED,
  single,
} from "@openbindings/sdk";
import { BINDING_SPEC } from "./constants.js";
import { MCPInvoker } from "./invoker.js";
import { ENDPOINT, mcpServer } from "./testserver.js";

const resultSchema = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
};

function sourceFor(name: string, outputSchema: unknown = resultSchema) {
  return {
    bindingSpec: BINDING_SPEC,
    location: ENDPOINT,
    content: {
      tools: [{
        name,
        inputSchema: { type: "object" },
        outputSchema,
      }],
    },
  };
}

describe("openbindings.mcp@1 invocation", () => {
  it("maps caller input wholesale and emits only structuredContent", async () => {
    const server = mcpServer(() => ({
      result: {
        content: [{ type: "text", text: "native shadow" }],
        structuredContent: { value: "ok" },
        _meta: { trace: "native" },
      },
    }));
    const call = new MCPInvoker().invokeBinding({
      source: sourceFor("probe"),
      ref: "tools/probe",
      fetch: server.fn,
    });
    await call.write({ q: "one" });

    await expect(single(call.outputs)).resolves.toEqual({ value: "ok" });
    expect(server.params("tools/call")).toEqual([{ name: "probe", arguments: { q: "one" } }]);
  });

  it("omits arguments when the caller supplies no input", async () => {
    const server = mcpServer(() => ({ result: { content: [], structuredContent: { value: "ok" } } }));
    const call = new MCPInvoker().invokeBinding({ source: sourceFor("probe"), ref: "tools/probe", fetch: server.fn });
    await call.close();
    await expect(single(call.outputs)).resolves.toEqual({ value: "ok" });
    expect(server.params("tools/call")[0]).not.toHaveProperty("arguments");
  });

  it("refuses non-object caller input before network I/O", async () => {
    const server = mcpServer(() => ({ result: { content: [], structuredContent: { value: "unreachable" } } }));
    const call = new MCPInvoker().invokeBinding({ source: sourceFor("probe"), ref: "tools/probe", fetch: server.fn });
    await call.write("not an object");
    await expect(call.closed).rejects.toMatchObject({ code: ERR_VALIDATION_FAILED });
    expect(server.fetches()).toBe(0);
  });

  it("classifies isError without emitting MCP result content", async () => {
    const server = mcpServer(() => ({
      result: {
        content: [{ type: "text", text: "tool-authored failure" }],
        structuredContent: { value: "not-success" },
        isError: true,
      },
    }));
    const call = new MCPInvoker().invokeBinding({ source: sourceFor("probe"), ref: "tools/probe", fetch: server.fn });
    await call.write({});
    await expect(call.closed).rejects.toMatchObject({
      code: ERR_EXECUTION_FAILED,
      message: "tool-authored failure",
    });
  });

  it.each([
    ["missing structuredContent", { content: [] }, /no structuredContent/],
    ["nonconforming structuredContent", { content: [], structuredContent: { value: 7 } }, /does not satisfy/],
  ])("refuses %s as unsuccessful completion", async (_name, result, message) => {
    const server = mcpServer(() => ({ result }));
    const call = new MCPInvoker().invokeBinding({ source: sourceFor("probe"), ref: "tools/probe", fetch: server.fn });
    await call.write({});
    await expect(call.closed).rejects.toMatchObject({ code: ERR_RESPONSE_ERROR });
    await expect(call.closed).rejects.toThrow(message);
  });

  it("never solicits protocol-native progress in the first candidate", async () => {
    const server = mcpServer((request) => ({
      result: { content: [], structuredContent: { value: "ok" } },
      headers: { "x-request-id": String(request.id) },
    }));
    const call = new MCPInvoker({ solicitProgress: true }).invokeBinding({
      source: sourceFor("probe"),
      ref: "tools/probe",
      context: { configuration: { solicit: true } },
      fetch: server.fn,
    });
    await call.write({});
    await expect(single(call.outputs)).resolves.toEqual({ value: "ok" });
    expect(server.params("tools/call")[0]).not.toHaveProperty("_meta");
  });

  it("carries an explicit bearer credential without changing operation values", async () => {
    const server = mcpServer(() => ({ result: { content: [], structuredContent: { value: "ok" } } }));
    const call = new MCPInvoker().invokeBinding({
      source: sourceFor("probe"),
      ref: "tools/probe",
      context: { bearerToken: "secret" },
      fetch: server.fn,
    });
    await call.write({});
    await expect(single(call.outputs)).resolves.toEqual({ value: "ok" });
    expect(server.calls.find((entry) => entry.method === "tools/call")?.headers.authorization).toBe("Bearer secret");
  });

  it.each([
    ["tool without outputSchema", { ...sourceFor("probe"), content: { tools: [{ name: "probe" }] } }, "tools/probe"],
    ["required-task tool", { ...sourceFor("probe"), content: { tools: [{ name: "probe", outputSchema: {}, execution: { taskSupport: "required" } }] } }, "tools/probe"],
    ["resource", { ...sourceFor("probe"), content: { resources: [{ uri: "app://x" }] } }, "resources/app://x"],
    ["prompt", { ...sourceFor("probe"), content: { prompts: [{ name: "review" }] } }, "prompts/review"],
  ])("refuses excluded %s offline", async (_name, source, ref) => {
    const server = mcpServer(() => ({ result: {} }));
    const call = new MCPInvoker().invokeBinding({ source, ref, fetch: server.fn });
    await expect(call.closed).rejects.toMatchObject({ code: ERR_REF_NOT_FOUND });
    expect(server.fetches()).toBe(0);
  });

  it("rejects every non-exact binding identifier before I/O", async () => {
    const server = mcpServer(() => ({ result: {} }));
    const call = new MCPInvoker().invokeBinding({
      source: { ...sourceFor("probe"), bindingSpec: "openbindings.mcp@2" },
      ref: "tools/probe",
      fetch: server.fn,
    });
    await expect(call.closed).rejects.toMatchObject({ code: ERR_SOURCE_CONFIG_ERROR });
    expect(server.fetches()).toBe(0);
  });

  it("cancels an in-flight tool call", async () => {
    const server = mcpServer(() => ({ hang: true }));
    const call = new MCPInvoker().invokeBinding({ source: sourceFor("slow"), ref: "tools/slow", fetch: server.fn });
    await call.write({});
    await new Promise<void>((resolve) => {
      const poll = () => server.count("tools/call") > 0 ? resolve() : setTimeout(poll, 0);
      poll();
    });
    await call.cancel();
    await expect(call.closed).rejects.toMatchObject({ code: ERR_CANCELLED });
  });
});

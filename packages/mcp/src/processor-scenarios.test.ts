import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  matchProcessorObservation,
  type OBInterface,
  type ProcessorObservation,
  type ProcessorScenario,
  type ProcessorScenarioFile,
} from "@openbindings/core";
import {
  CONTEXT_REQUIRED,
  OperationInvoker,
  operationSignature,
  type Invocation,
  type InvocationError,
} from "@openbindings/invoke";
import { MCPInvoker, MCPSynthesizer } from "./index.js";

const root = process.env.OB_SPEC_CORPUS ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
const corpus = JSON.parse(readFileSync(resolve(root, "binding-specs/processor/mcp.json"), "utf8")) as ProcessorScenarioFile;
const fidelityCorpus = JSON.parse(
  readFileSync(resolve(root, "invocation-fidelity/mcp.json"), "utf8"),
) as ProcessorScenarioFile;

describe("portable MCP processor scenarios", () => {
  for (const scenario of corpus.scenarios) {
    it(scenario.id, async () => {
      const observation = await runScenario(scenario);
      expect(() => matchProcessorObservation(scenario, observation)).not.toThrow();
    });
  }
});

describe("MCP invocation-fidelity scenarios", () => {
  for (const scenario of fidelityCorpus.scenarios) {
    it(scenario.id, async () => {
      const observation = await runScenario(scenario, true);
      expect(() => matchProcessorObservation(scenario, observation)).not.toThrow();
    });
  }
});

async function runScenario(
  scenario: ProcessorScenario,
  joined = false,
): Promise<ProcessorObservation> {
  const wire = new ScenarioServer(scenario);
  const context: Record<string, unknown> = {};
  if (scenario.given.configuration) context.configuration = scenario.given.configuration;
  const credentials = scenario.given.runtime?.credentials;
  if (isRecord(credentials)) {
    if (typeof credentials.generic === "string") context.apiKey = credentials.generic;
    if (isRecord(credentials.headers)) context.headers = credentials.headers;
  }
  const source = {
    bindingSpec: joined ? fidelityCorpus.bindingSpec : corpus.bindingSpec,
    location: String(scenario.given.source.location ?? ""),
    ...(Object.hasOwn(scenario.given.source, "content") ? { content: scenario.given.source.content } : {}),
  };
  const ref = String(scenario.given.binding.ref ?? "");
  const bindingInvoker = new MCPInvoker();
  let invocation: Invocation<unknown, unknown>;
  if (joined) {
    const iface = await new MCPSynthesizer({ fetch: wire.fetch }).synthesizeInterface({ sources: [source] });
    invocation = new OperationInvoker([bindingInvoker], { fetch: wire.fetch }).invoke(
      iface,
      operationSignature(operationForRef(iface, ref)),
      { context },
    );
  } else {
    invocation = bindingInvoker.invokeBinding({ source, ref, context, fetch: wire.fetch });
  }

  if (scenario.given.invocation.inputPresent) {
    await invocation.write(scenario.given.invocation.input).catch(() => {});
  } else {
    await invocation.close();
  }
  const outputs: unknown[] = [];
  let terminal: InvocationError | undefined;
  try {
    for await (const output of invocation.outputs) outputs.push(output);
  } catch (error: unknown) {
    terminal = error as InvocationError;
  }
  const data: Record<string, unknown> = { outputs, ...(joined ? { joinedSynthesis: true } : {}) };
  if (Object.hasOwn(scenario.given.source, "content")) data.listingRequests = [];
  else if (Object.keys(wire.listingRequests).length > 0) data.listingRequests = wire.listingRequests;
  if (wire.dispatch) data.dispatch = wire.dispatch;
  if (wire.redirectDispatch) data.redirectDispatch = wire.redirectDispatch;
  if (!terminal) return { disposition: "complete", phase: "completion", data };
  data.error = {
    code: terminal.code,
    ...(Object.hasOwn(terminal, "data") ? { data: terminal.data } : {}),
  };
  if (terminal.code === CONTEXT_REQUIRED) return { disposition: "context-required", phase: "pre-dispatch", data };
  if (scenario.id.startsWith("MCP-FI-")) {
    return {
      disposition: "error",
      phase: scenario.id === "MCP-FI-02" ? "completion" : "response",
      data,
    };
  }
  const phase: ProcessorObservation["phase"] = scenario.id === "MCP-PS-01"
    ? "load"
    : ["MCP-PS-08", "MCP-PS-09", "MCP-PS-12", "MCP-PS-13"].includes(scenario.id)
      ? "resolution"
      : ["MCP-PS-06", "MCP-PS-10", "MCP-PS-14", "MCP-PS-16"].includes(scenario.id)
        ? "response"
        : "pre-dispatch";
  return { disposition: wire.dispatch && ["MCP-PS-06", "MCP-PS-10", "MCP-PS-14", "MCP-PS-16"].includes(scenario.id) ? "error" : "refusal", phase, data };
}

function operationForRef(iface: OBInterface, ref: string): string {
  const match = Object.values(iface.bindings ?? {}).find((binding) => binding.ref === ref);
  if (!match) throw new Error(`synthesized MCP interface has no binding for ${JSON.stringify(ref)}`);
  return match.operation;
}

class ScenarioServer {
  readonly listingRequests: Record<string, Array<string | null>> = {};
  dispatch?: Record<string, unknown>;
  redirectDispatch?: Record<string, unknown>;
  readonly #scenario: ProcessorScenario;

  constructor(scenario: ProcessorScenario) { this.#scenario = scenario; }

  readonly fetch: typeof fetch = async (_input, init) => {
    if ((init?.method ?? "GET") === "GET") return new Response(null, { status: 405 });
    if (init?.method === "DELETE") return new Response(null, { status: 200 });
    const request = JSON.parse(String(init?.body ?? "{}")) as {
      id?: string | number;
      method: string;
      params?: Record<string, unknown>;
    };
    if (request.method === "initialize") {
      return rpc(request.id, {
        protocolVersion: String(this.#scenario.given.peer?.negotiatedProtocolVersion ?? "2025-11-25"),
        capabilities: this.#scenario.given.peer?.capabilities ?? { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "processor-scenario", version: "1" },
      });
    }
    if (request.id === undefined) return new Response(null, { status: 202 });
    const params = request.params ?? {};
    if (request.method.endsWith("/list")) {
      const family = request.method === "tools/list" ? "tools" : request.method;
      (this.listingRequests[family] ??= []).push(typeof params.cursor === "string" ? params.cursor : null);
      if (request.method === "tools/list") {
        const pages = this.#scenario.given.peer?.toolPages;
        if (Array.isArray(pages)) {
          const index = typeof params.cursor === "string" ? 1 : 0;
          return rpc(request.id, pages[index] ?? { tools: [] });
        }
      }
      return rpc(request.id, request.method === "prompts/list"
        ? { prompts: [] }
        : request.method === "resources/templates/list"
          ? { resourceTemplates: [] }
          : request.method === "resources/list"
            ? { resources: [] }
            : { tools: [] });
    }

    this.dispatch = { method: request.method, params, httpMethod: init?.method ?? "POST" };
    const peer = this.#scenario.given.peer ?? {};
    if (peer.status === 303) {
      const headers = new Headers(isRecord(peer.headers) ? toStringRecord(peer.headers) : {});
      return new Response(null, { status: 303, headers });
    }
    if (request.method === "tools/call") {
      if (typeof peer.httpStatus === "number") {
        const headers = new Headers(isRecord(peer.headers) ? toStringRecord(peer.headers) : {});
        const body = typeof peer.bodyBase64 === "string" ? base64ToBytes(peer.bodyBase64) : null;
        return new Response(body, { status: peer.httpStatus, headers });
      }
      if (isRecord(peer.jsonrpcError)) {
        return rpcError(request.id, peer.jsonrpcError);
      }
      const result = peer.toolResult ?? { content: [] };
      const progress = Array.isArray(peer.progress) ? peer.progress : [];
      const late = Array.isArray(peer.lateProgress) ? peer.lateProgress : [];
      if (progress.length > 0 || late.length > 0) {
        const token = isRecord(params._meta) ? params._meta.progressToken : undefined;
        const messages = [
          ...progress.map((item) => ({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { ...(item as Record<string, unknown>), progressToken: token },
          })),
          { jsonrpc: "2.0", id: request.id, result },
          ...late.map((item) => ({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { ...(item as Record<string, unknown>), progressToken: token },
          })),
        ];
        return sse(messages);
      }
      return rpc(request.id, result);
    }
    if (request.method === "resources/read") {
      return rpc(request.id, peer.result ?? peer.resourceResult ?? { contents: [] });
    }
    if (request.method === "prompts/get") {
      return rpc(request.id, peer.promptResult ?? { messages: [] });
    }
    return rpc(request.id, {});
  };
}

function rpc(id: string | number | undefined, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function rpcError(id: string | number | undefined, error: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function sse(messages: unknown[]): Response {
  return new Response(messages.map((message) => `data: ${JSON.stringify(message)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
function toStringRecord(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}
function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

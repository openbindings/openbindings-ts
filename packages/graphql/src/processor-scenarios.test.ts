import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTEXT_REQUIRED,
  matchProcessorObservation,
  OperationInvoker,
  operationSignature,
  type Invocation,
  type InvocationError,
  type OBInterface,
  type ProcessorObservation,
  type ProcessorScenario,
  type ProcessorScenarioFile,
} from "@openbindings/sdk";
import { describe, expect, it } from "vitest";
import type { GraphQLWebSocketInit } from "./configuration.js";
import { GraphQLInvoker, GraphQLSynthesizer } from "./invoker.js";

const root = process.env.OB_SPEC_CORPUS
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
const corpus = JSON.parse(
  readFileSync(resolve(root, "binding-specs/processor/graphql.json"), "utf8"),
) as ProcessorScenarioFile;
const fidelityCorpus = JSON.parse(
  readFileSync(resolve(root, "invocation-fidelity/graphql.json"), "utf8"),
) as ProcessorScenarioFile;

describe("portable GraphQL processor scenarios", () => {
  for (const scenario of corpus.scenarios) {
    it(scenario.id, async () => {
      const observation = await runScenario(scenario);
      expect(() => matchProcessorObservation(scenario, observation)).not.toThrow();
    });
  }
});

describe("GraphQL invocation-fidelity scenarios", () => {
  for (const scenario of fidelityCorpus.scenarios) {
    it(scenario.id, async () => {
      const observation = await runScenario(scenario, true);
      expect(() => matchProcessorObservation(scenario, observation)).not.toThrow();
    });
  }
});

async function runScenario(scenario: ProcessorScenario, joined = false): Promise<ProcessorObservation> {
  const peer = scenario.given.peer ?? {};
  const introspectionRequests: unknown[] = [];
  let dispatch: Record<string, unknown> | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (String(body.query).includes("__schema")) introspectionRequests.push(body);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => { headers[name.toLowerCase()] = value; });
    dispatch = { target: String(input), method: init?.method ?? "GET", headers, body };
    const responseHeaders = new Headers();
    if (typeof peer.contentType === "string") responseHeaders.set("content-type", peer.contentType);
    if (isRecord(peer.headers)) {
      for (const [name, value] of Object.entries(peer.headers)) responseHeaders.set(name, String(value));
    }
    const responseBody = typeof peer.bodyBase64 === "string"
      ? base64ToBytes(peer.bodyBase64)
      : JSON.stringify(peer.body ?? {});
    return new Response(responseBody, {
      status: typeof peer.status === "number" ? peer.status : 200,
      headers: responseHeaders,
    });
  };

  let socket: ScenarioWebSocket | undefined;
  let socketInit: GraphQLWebSocketInit | undefined;
  const invoker = new GraphQLInvoker((init) => {
    socketInit = init;
    socket = new ScenarioWebSocket();
    return socket as unknown as WebSocket;
  });
  const context: Record<string, unknown> = {};
  if (scenario.given.configuration) context.configuration = scenario.given.configuration;
  const credentials = scenario.given.runtime?.credentials;
  if (credentials !== null && typeof credentials === "object" && !Array.isArray(credentials)) {
    Object.assign(context, credentials);
  }
  const source = {
    bindingSpec: joined ? fidelityCorpus.bindingSpec : corpus.bindingSpec,
    ...(typeof scenario.given.source.location === "string" ? { location: scenario.given.source.location } : {}),
    ...(Object.hasOwn(scenario.given.source, "content") ? { content: scenario.given.source.content } : {}),
  };
  const ref = typeof scenario.given.binding.ref === "string" ? scenario.given.binding.ref : "";
  let invocation: Invocation<unknown, unknown>;
  if (joined) {
    const iface = await new GraphQLSynthesizer().synthesizeInterface({ sources: [source] });
    invocation = new OperationInvoker([invoker], { fetch: fetchImpl }).invoke(
      iface,
      operationSignature(operationForRef(iface, ref)),
      { context },
    );
  } else {
    invocation = invoker.invokeBinding({
      source,
      ref,
      context,
      ...(scenario.given.invocation.inputPresent ? { inputSchema: { type: "object" } } : {}),
      fetch: fetchImpl,
    });
  }
  if (scenario.given.invocation.inputPresent) {
    await invocation.write(scenario.given.invocation.input).catch(() => {});
  } else {
    await invocation.close().catch(() => {});
  }

  const outputTask = collectOutputs(invocation);
  if (
    typeof scenario.given.binding.ref === "string"
    && scenario.given.binding.ref.startsWith("subscription/")
  ) {
    for (let i = 0; i < 20 && !socket; i++) await Promise.resolve();
    if (socket) {
      socket.open();
      socket.message({ type: "connection_ack" });
      for (const message of Array.isArray(peer.messages) ? peer.messages.slice(1) : []) {
        socket.message(message);
      }
    }
  }
  const { outputs, terminal } = await outputTask;

  if (socket && socketInit) {
    const initMessage = socket.sent[0] as Record<string, unknown> | undefined;
    const subscribe = socket.sent[1] as Record<string, unknown> | undefined;
    dispatch = {
      target: socketInit.url,
      headers: socketInit.headers,
      connectionInit: initMessage,
      body: subscribe?.payload,
    };
  }
  const data: Record<string, unknown> = { outputs, introspectionRequests, ...(joined ? { joinedSynthesis: true } : {}) };
  if (dispatch) data.dispatch = dispatch;
  if (terminal?.code === CONTEXT_REQUIRED) data.context = terminal.data;
  if (!terminal) return { disposition: "complete", phase: "completion", data };
  data.error = {
    code: terminal.code,
    ...(Object.hasOwn(terminal, "data") ? { data: terminal.data } : {}),
  };
  if (terminal.code === CONTEXT_REQUIRED) return { disposition: "context-required", phase: "pre-dispatch", data };
  if (!dispatch) return { disposition: "refusal", phase: "pre-dispatch", data };
  return {
    disposition: "error",
    phase: scenario.id === "GQL-PS-07" || outputs.length === 0
      ? "response"
      : "completion",
    data,
  };
}

function operationForRef(iface: OBInterface, ref: string): string {
  const match = Object.values(iface.bindings ?? {}).find((binding) => binding.ref === ref);
  if (!match) throw new Error(`synthesized GraphQL interface has no binding for ${JSON.stringify(ref)}`);
  return match.operation;
}

async function collectOutputs(invocation: Invocation<unknown, unknown>): Promise<{
  outputs: unknown[];
  terminal?: InvocationError;
}> {
  const outputs: unknown[] = [];
  try {
    for await (const output of invocation.outputs) outputs.push(output);
    return { outputs };
  } catch (error: unknown) {
    return { outputs, terminal: error as InvocationError };
  }
}

class ScenarioWebSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: unknown[] = [];

  send(value: string): void { this.sent.push(JSON.parse(value)); }
  close(): void { this.readyState = 3; }
  open(): void { this.readyState = WebSocket.OPEN; this.onopen?.(); }
  message(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

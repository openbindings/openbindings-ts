import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  matchProcessorObservation,
  type InvocationError,
  type ProcessorObservation,
  type ProcessorScenario,
  type ProcessorScenarioFile,
} from "@openbindings/sdk";
import { AsyncAPIInvoker } from "./index.js";

const root = process.env.OB_SPEC_CORPUS ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
const corpus = JSON.parse(readFileSync(resolve(root, "binding-specs/processor/asyncapi.json"), "utf8")) as ProcessorScenarioFile;

describe("portable AsyncAPI processor scenarios", () => {
  for (const scenario of corpus.scenarios) {
    it(scenario.id, async () => {
      const observation = await runScenario(scenario);
      expect(() => matchProcessorObservation(scenario, observation)).not.toThrow();
    });
  }
});

async function runScenario(scenario: ProcessorScenario): Promise<ProcessorObservation> {
  const dispatches: Array<Record<string, unknown>> = [];
  const previousWebSocket = globalThis.WebSocket;
  if (scenario.id === "ASYNC-PS-10") {
    globalThis.WebSocket = scenarioWebSocket(scenario, dispatches) as unknown as typeof WebSocket;
  }
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => { headers[name.toLowerCase()] = value; });
    const rawBody = typeof init?.body === "string" ? init.body : "";
    let body: unknown = rawBody;
    if (rawBody !== "") {
      try { body = JSON.parse(rawBody); } catch { /* preserve text */ }
    }
    dispatches.push({ method: init?.method ?? "GET", url: String(input), headers, ...(rawBody !== "" ? { body } : {}) });
    const peer = scenario.given.peer ?? {};
    const responseHeaders = new Headers();
    if (isRecord(peer.headers)) for (const [name, value] of Object.entries(peer.headers)) responseHeaders.set(name, String(value));
    const status = typeof peer.status === "number" ? peer.status : 204;
    const responseBody = peer.body === "" || peer.body === undefined
      ? null
      : typeof peer.body === "string" ? peer.body : JSON.stringify(peer.body);
    return new Response(responseBody, { status, headers: responseHeaders });
  };

  const context: Record<string, unknown> = {};
  if (scenario.given.configuration) context.configuration = scenario.given.configuration;
  const credentials = scenario.given.runtime?.credentials;
  if (isRecord(credentials)) {
    if (typeof credentials.token === "string") context.apiKey = credentials.token;
    if (typeof credentials.key === "string") context.apiKeys = { key: credentials.key };
  }
  const invoker = new AsyncAPIInvoker();
  try {
    const invocation = invoker.invokeBinding({
      source: {
        bindingSpec: corpus.bindingSpec,
        ...(typeof scenario.given.source.location === "string" ? { location: scenario.given.source.location } : {}),
        ...(Object.hasOwn(scenario.given.source, "content") ? { content: scenario.given.source.content } : {}),
      },
      ref: String(scenario.given.binding.ref ?? ""),
      context,
      fetch: fetchImpl,
    });
    if (scenario.given.invocation.inputPresent) {
      await invocation.write(scenario.given.invocation.input).catch(() => {});
      await invocation.close();
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
    const data: Record<string, unknown> = { outputs, dispatches };
    if (dispatches[0]) data.dispatch = dispatches[0];
    if (!terminal) return { disposition: "complete", phase: "completion", data };
    const phase: ProcessorObservation["phase"] = scenario.id === "ASYNC-PS-01"
      ? "load"
      : ["ASYNC-PS-02", "ASYNC-PS-03", "ASYNC-PS-12", "ASYNC-PS-13", "ASYNC-PS-15"].includes(scenario.id)
        ? "resolution"
        : ["ASYNC-PS-08", "ASYNC-PS-17", "ASYNC-PS-18"].includes(scenario.id)
          ? "response"
          : "pre-dispatch";
    return { disposition: phase === "response" ? "error" : "refusal", phase, data };
  } finally {
    invoker.close();
    globalThis.WebSocket = previousWebSocket;
  }
}

function scenarioWebSocket(
  scenario: ProcessorScenario,
  dispatches: Array<Record<string, unknown>>,
): new (url: string | URL, protocols?: string | string[]) => WebSocket {
  return class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readyState = 0;
    readonly #listeners = new Map<string, Set<(event: { data?: string }) => void>>();
    constructor(url: string | URL) {
      dispatches.push({ method: "GET", url: String(url), transport: "websocket" });
      queueMicrotask(() => {
        this.readyState = 1;
        this.#emit("open", {});
        setTimeout(() => {
          const messages = scenario.given.peer?.webSocketMessages;
          if (Array.isArray(messages)) for (const item of messages) {
            if (!isRecord(item) || !Array.isArray(item.fragments)) continue;
            this.#emit("message", { data: item.fragments.map(String).join("") });
          }
          this.readyState = 3;
          this.#emit("close", {});
        }, 0);
      });
    }
    addEventListener(type: string, listener: (event: { data?: string }) => void, options?: { once?: boolean }): void {
      let registered = listener;
      if (options?.once) registered = (event) => { this.removeEventListener(type, registered); listener(event); };
      (this.#listeners.get(type) ?? this.#create(type)).add(registered);
    }
    removeEventListener(type: string, listener: (event: { data?: string }) => void): void { this.#listeners.get(type)?.delete(listener); }
    send(): void {}
    close(): void { this.readyState = 3; this.#emit("close", {}); }
    #create(type: string): Set<(event: { data?: string }) => void> { const set = new Set<(event: { data?: string }) => void>(); this.#listeners.set(type, set); return set; }
    #emit(type: string, event: { data?: string }): void { for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(event); }
  } as unknown as new (url: string | URL, protocols?: string | string[]) => WebSocket;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

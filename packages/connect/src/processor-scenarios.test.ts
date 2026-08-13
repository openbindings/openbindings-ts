import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
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
import { ConnectInvoker, ConnectSynthesizer, envelope } from "./index.js";

const root = process.env.OB_SPEC_CORPUS ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
const corpus = JSON.parse(readFileSync(resolve(root, "binding-specs/processor/connect.json"), "utf8")) as ProcessorScenarioFile;
const fidelityCorpus = JSON.parse(readFileSync(resolve(root, "invocation-fidelity/connect.json"), "utf8")) as ProcessorScenarioFile;

describe("portable Connect processor scenarios", () => {
  for (const scenario of corpus.scenarios) {
    it(scenario.id, async () => {
      const observation = await runScenario(scenario);
      expect(() => matchProcessorObservation(scenario, observation)).not.toThrow();
    });
  }
});

describe("Connect invocation-fidelity scenarios", () => {
  for (const scenario of fidelityCorpus.scenarios) {
    it(scenario.id, async () => {
      const observation = await runScenario(scenario, true);
      expect(() => matchProcessorObservation(scenario, observation)).not.toThrow();
    });
  }
});

async function runScenario(scenario: ProcessorScenario, joined = false): Promise<ProcessorObservation> {
  const dispatches: Array<Record<string, unknown>> = [];
  const peer = scenario.given.peer ?? {};
  let peerEndStreamCount = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => { headers[name.toLowerCase()] = value; });
    const bytes = await requestBytes(init?.body);
    const dispatch: Record<string, unknown> = {
      method: init?.method ?? "GET",
      url: String(input),
      headers,
    };
    if ((headers["content-type"] ?? "").startsWith("application/connect+")) {
      dispatch.requestEnvelopes = decodeRequestEnvelopes(bytes);
    } else if (bytes.length > 0) {
      dispatch.body = JSON.parse(new TextDecoder().decode(bytes));
    }
    dispatches.push(dispatch);

    const responseHeaders = new Headers();
    if (typeof peer.contentType === "string") responseHeaders.set("Content-Type", peer.contentType);
    if (isRecord(peer.headers)) for (const [name, value] of Object.entries(peer.headers)) responseHeaders.set(name, String(value));
    const status = typeof peer.status === "number" ? peer.status : 200;
    if (Array.isArray(peer.envelopes)) {
      const frames: Uint8Array[] = [];
      for (const item of peer.envelopes) {
        if (isRecord(item) && Object.hasOwn(item, "message")) {
          frames.push(envelope(0, encodeJSON(item.message)));
        } else if (isRecord(item) && Object.hasOwn(item, "endStream")) {
          peerEndStreamCount++;
          frames.push(envelope(0x02, encodeJSON(item.endStream)));
        } else if (isRecord(item) && typeof item.endStreamBase64 === "string") {
          peerEndStreamCount++;
          frames.push(envelope(0x02, base64ToBytes(item.endStreamBase64)));
        }
      }
      return new Response(concatBytes(...frames) as BodyInit, { status, headers: responseHeaders });
    }
    const body = typeof peer.bodyBase64 === "string"
      ? base64ToBytes(peer.bodyBase64)
      : peer.body === "" ? "" : JSON.stringify(peer.body ?? {});
    return new Response(body, { status, headers: responseHeaders });
  };

  const context: Record<string, unknown> = {};
  if (scenario.given.configuration) context.configuration = scenario.given.configuration;
  if (isRecord(scenario.given.runtime?.requestMetadata)) context.headers = scenario.given.runtime.requestMetadata;
  const credentials = scenario.given.runtime?.credentials;
  if (isRecord(credentials) && typeof credentials.generic === "string") context.apiKey = credentials.generic;
  const available = scenario.given.runtime?.availableHttpVersions;
  const fullDuplex = !Array.isArray(available) || available.includes("2");
  const source = {
    bindingSpec: joined ? fidelityCorpus.bindingSpec : corpus.bindingSpec,
    ...(typeof scenario.given.source.location === "string" ? { location: scenario.given.source.location } : {}),
    ...(Object.hasOwn(scenario.given.source, "content") ? { content: scenario.given.source.content } : {}),
  };
  const ref = typeof scenario.given.binding.ref === "string" ? scenario.given.binding.ref : "";
  const bindingInvoker = new ConnectInvoker({ fullDuplex });
  let invocation: Invocation<unknown, unknown>;
  if (joined) {
    const iface = await new ConnectSynthesizer().synthesizeInterface({ sources: [source] });
    invocation = new OperationInvoker([bindingInvoker], { fetch: fetchImpl }).invoke(
      iface,
      operationSignature(operationForRef(iface, ref)),
      { context },
    );
  } else {
    invocation = bindingInvoker.invokeBinding({ source, ref, context, fetch: fetchImpl });
  }

  const writes = Array.isArray(scenario.given.invocation.writes) ? scenario.given.invocation.writes : undefined;
  if (writes) {
    for (const value of writes) await invocation.write(value).catch(() => {});
    await invocation.close();
  } else if (scenario.given.invocation.inputPresent) {
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
  const data: Record<string, unknown> = {
    schemaMode: Object.hasOwn(scenario.given.source, "content"),
    reflectionRequests: [],
    outputs,
    dispatches,
    peer: { endStreamCount: peerEndStreamCount },
    ...(joined ? { joinedSynthesis: true } : {}),
  };
  if (dispatches[0]) data.dispatch = dispatches[0];
  if (!terminal) return { disposition: "complete", phase: "completion", data };
  data.error = {
    code: terminal.code,
    ...(Object.hasOwn(terminal, "data") ? { data: terminal.data } : {}),
  };
  if (terminal.code === CONTEXT_REQUIRED) return { disposition: "context-required", phase: "pre-dispatch", data };
  if (dispatches.length === 0) return { disposition: "refusal", phase: "pre-dispatch", data };
  const responsePhase = ["CONN-PS-02", "CONN-PS-09", "CONN-PS-13", "CONN-PS-15", "CONN-FI-02"].includes(scenario.id);
  return { disposition: "error", phase: responsePhase ? "response" : "completion", data };
}

function operationForRef(iface: OBInterface, ref: string): string {
  const match = Object.values(iface.bindings ?? {}).find((binding) => binding.ref === ref);
  if (!match) throw new Error(`synthesized Connect interface has no binding for ${JSON.stringify(ref)}`);
  return match.operation;
}

async function requestBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body === undefined || body === null) return new Uint8Array();
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof ReadableStream) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body as ReadableStream<Uint8Array>) chunks.push(chunk);
    return concatBytes(...chunks);
  }
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function decodeRequestEnvelopes(bytes: Uint8Array): unknown[] {
  const messages: unknown[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const flags = bytes[offset]!;
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0);
    const payload = bytes.slice(offset + 5, offset + 5 + length);
    if ((flags & 0x02) === 0) messages.push({ message: JSON.parse(new TextDecoder().decode(payload)) });
    offset += 5 + length;
  }
  return messages;
}

function encodeJSON(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(value)); }
function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

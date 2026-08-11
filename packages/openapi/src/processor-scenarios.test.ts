import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import jsonata from "jsonata";
import {
  CONTEXT_REQUIRED,
  ERR_INVALID_REF,
  ERR_REF_NOT_FOUND,
  ERR_SOURCE_LOAD_FAILED,
  OperationInvoker,
  matchProcessorObservation,
  operationSignature,
  type InvocationError,
  type ProcessorObservation,
  type ProcessorScenario,
  type ProcessorScenarioFile,
} from "@openbindings/sdk";
import { OpenAPIInvoker, OpenAPISynthesizer } from "./invoker.js";

const corpusRoot = process.env.OB_SPEC_CORPUS ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
const corpus = JSON.parse(
  readFileSync(resolve(corpusRoot, "binding-specs/processor/openapi.json"), "utf8"),
) as ProcessorScenarioFile;
const fidelityCorpus = JSON.parse(
  readFileSync(resolve(corpusRoot, "invocation-fidelity/openapi.json"), "utf8"),
) as ProcessorScenarioFile;

describe("portable OpenAPI processor scenarios", () => {
  for (const scenario of corpus.scenarios) {
    it(scenario.id, async () => {
      const observation = await runScenario(scenario);
      try {
        matchProcessorObservation(scenario, observation);
      } catch (error: unknown) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nobservation: ${JSON.stringify(observation)}`,
          { cause: error },
        );
      }
    });
  }
});

describe("OpenAPI invocation-fidelity scenarios", () => {
  for (const scenario of fidelityCorpus.scenarios) {
    it(scenario.id, async () => {
      const observation = await runScenario(scenario, fidelityCorpus);
      expect(() => matchProcessorObservation(scenario, observation)).not.toThrow();
    });
  }
});

async function runScenario(
  scenario: ProcessorScenario,
  scenarioFile: ProcessorScenarioFile = corpus,
): Promise<ProcessorObservation> {
  const dispatches: Array<Record<string, unknown>> = [];
  const peer = scenario.given.peer ?? {};
  const fetchMock: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const resource = scenario.given.resources?.[url];
    if (resource !== undefined) {
      return new Response(
        typeof resource === "string" ? resource : JSON.stringify(resource),
        { status: 200 },
      );
    }
    const headers = new Headers(init?.headers);
    const dispatch: Record<string, unknown> = {
      method: init?.method ?? "GET",
      url,
      headers: normalizedHeaders(headers),
    };
    const body = await observedBody(init?.body);
    if (body.present) {
      dispatch.body = body.value;
      if (body.base64 !== undefined) dispatch.bodyBase64 = body.base64;
      if (body.byteLength !== undefined) dispatch.bodyByteLength = body.byteLength;
    }
    dispatches.push(dispatch);

    const status = typeof peer.status === "number" ? peer.status : 599;
    const rawBody = typeof peer.bodyBase64 === "string"
      ? base64ToBytes(peer.bodyBase64)
      : typeof peer.body === "string"
        ? peer.body
        : "";
    const responseBody = rawBody === "" && (status === 204 || status === 205 || status === 304)
      ? null
      : rawBody;
    return new Response(responseBody, {
      status,
      headers: (peer.headers ?? {}) as Record<string, string>,
    });
  };

  const context: Record<string, unknown> = {};
  if (scenario.given.configuration) context.configuration = scenario.given.configuration;
  const credentials = scenario.given.runtime?.credentials;
  if (credentials && typeof credentials === "object") context.apiKeys = credentials;

  const source = scenario.given.source;
  const binding = scenario.given.binding;
  const invocationSource = {
      bindingSpec: scenarioFile.bindingSpec,
      ...(typeof source.location === "string" ? { location: source.location } : {}),
      ...(Object.prototype.hasOwnProperty.call(source, "content") ? { content: source.content } : {}),
  };
  const joined = scenarioFile.format === "openbindings.invocation-fidelity-scenarios@1";
  const call = joined
    ? new OperationInvoker([new OpenAPIInvoker()], {
      fetch: fetchMock,
      transformEvaluator: {
        evaluate: (expression, data) => jsonata(expression).evaluate(data),
      },
    }).invoke(
      await new OpenAPISynthesizer({ fetch: fetchMock }).synthesizeInterface({ sources: [invocationSource] }),
      operationSignature(fidelityOperationId(source.content)),
      { context },
    )
    : new OpenAPIInvoker().invokeBinding({
      source: invocationSource,
      ref: typeof binding.ref === "string" ? binding.ref : "",
      context,
      fetch: fetchMock,
    });

  if (scenario.given.invocation.inputPresent === true) {
    await call.write(scenario.given.invocation.input).catch(() => {});
  } else {
    await call.close();
  }

  const outputs: unknown[] = [];
  let terminal: InvocationError | undefined;
  try {
    for await (const output of call.outputs) outputs.push(output);
  } catch (error: unknown) {
    terminal = error as InvocationError;
  }

  const data: Record<string, unknown> = { outputs, ...(joined ? { joinedSynthesis: true } : {}) };
  if (dispatches.length > 0) {
    data.dispatch = dispatches[0];
    data.dispatches = dispatches;
  }
  if (!terminal) {
    const trailer = call.diagnostics.trailing();
    const governing = trailer["x-ob-governing-media"];
    if (governing?.length === 1) data.response = { governingMedia: governing[0] };
    return { disposition: "complete", phase: "completion", data };
  }
  const disposition = terminal.code === CONTEXT_REQUIRED
    ? "context-required"
    : dispatches.length > 0
      ? "error"
      : "refusal";
  return {
    disposition,
    phase: errorPhase(terminal, dispatches.length > 0),
    data: {
      ...data,
      ...(terminal.code === CONTEXT_REQUIRED && terminal.details !== undefined
        ? { context: terminal.details }
        : {}),
      error: {
        code: terminal.code,
        message: terminal.message,
        ...(terminal.details !== undefined ? { details: terminal.details } : {}),
        ...(terminal.diagnostics !== undefined ? { diagnostics: terminal.diagnostics } : {}),
      },
    },
  };
}

function fidelityOperationId(content: unknown): string {
  const document = content as { paths?: Record<string, Record<string, { operationId?: unknown }>> };
  for (const path of Object.values(document.paths ?? {})) {
    for (const operation of Object.values(path)) {
      if (typeof operation.operationId === "string") return operation.operationId;
    }
  }
  throw new Error("fidelity artifact omits operationId");
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function observedBody(
  body: BodyInit | null | undefined,
): Promise<{ present: boolean; value?: unknown; base64?: string; byteLength?: number }> {
  if (body == null) return { present: false };
  if (typeof body === "string") {
    if (body === "") return { present: false };
    const bytes = new TextEncoder().encode(body);
    try {
      return {
        present: true,
        value: JSON.parse(body),
        base64: bytesToBase64(bytes),
        byteLength: bytes.byteLength,
      };
    } catch {
      return {
        present: true,
        value: body,
        base64: bytesToBase64(bytes),
        byteLength: bytes.byteLength,
      };
    }
  }
  if (body instanceof URLSearchParams) return { present: true, value: body.toString() };
  if (ArrayBuffer.isView(body)) {
    const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return {
      present: true,
      value: new TextDecoder().decode(bytes),
      base64: bytesToBase64(bytes),
      byteLength: bytes.byteLength,
    };
  }
  if (body instanceof ArrayBuffer) {
    const bytes = new Uint8Array(body);
    return {
      present: true,
      value: new TextDecoder().decode(bytes),
      base64: bytesToBase64(bytes),
      byteLength: bytes.byteLength,
    };
  }
  return { present: true, value: String(body) };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function normalizedHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    const canonical = name.split("-").map((part: string) => part.charAt(0).toUpperCase() + part.slice(1)).join("-");
    out[name] = value;
    out[canonical] = value;
  });
  return out;
}

function errorPhase(error: InvocationError, dispatched: boolean): ProcessorObservation["phase"] {
  if (dispatched) return "response";
  if (error.code === ERR_SOURCE_LOAD_FAILED) return "load";
  const diagnostics = error.diagnostics as
    | { openapiClient?: { message?: unknown } }
    | undefined;
  const nativeMessage = diagnostics?.openapiClient?.message;
  const message = typeof nativeMessage === "string" ? nativeMessage : (error.message ?? "");
  if (
    error.code === ERR_INVALID_REF || error.code === ERR_REF_NOT_FOUND ||
    message.includes("unflattenable") || message.includes("normalized collision") ||
    message.includes("different locations") || message.includes("case-insensitive")
  ) return "resolution";
  return "pre-dispatch";
}

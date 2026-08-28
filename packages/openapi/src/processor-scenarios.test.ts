import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import jsonata from "jsonata";
import {
  matchProcessorObservation,
  type ProcessorObservation,
  type ProcessorScenario,
  type ProcessorScenarioFile,
} from "@openbindings/core";
import {
  CONTEXT_REQUIRED,
  ERR_INVALID_SELECTOR,
  ERR_SELECTOR_NOT_FOUND,
  ERR_SOURCE_LOAD_FAILED,
  OperationInvoker,
  operationSignature,
  type InvocationError,
} from "@openbindings/invoke";
import { OpenAPIInvoker, OpenAPISynthesizer } from "./invoker.js";
import { Swagger20Number } from "@openbindings/openapi-client/engine";

if (process.env.OB_CORPUS_REQUIRED === "1" && !process.env.OB_SPEC_CORPUS) {
  throw new Error("OB_CORPUS_REQUIRED=1 requires OB_SPEC_CORPUS");
}
const corpusRoot = process.env.OB_SPEC_CORPUS ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
const corpusEntries = [
  {
    file: "openapi-2.0.json",
    wanted: new Set([
      "OAPI20-PS-01",
      "OAPI20-PS-02", "OAPI20-PS-03", "OAPI20-PS-04", "OAPI20-PS-05", "OAPI20-PS-06",
      "OAPI20-PS-07", "OAPI20-PS-08", "OAPI20-PS-09", "OAPI20-PS-10", "OAPI20-PS-11",
      "OAPI20-PS-12", "OAPI20-PS-13", "OAPI20-PS-14", "OAPI20-PS-15", "OAPI20-PS-16",
      "OAPI20-PS-17", "OAPI20-PS-18", "OAPI20-PS-19", "OAPI20-PS-20", "OAPI20-PS-21",
      "OAPI20-PS-22", "OAPI20-PS-23", "OAPI20-PS-24", "OAPI20-PS-25", "OAPI20-PS-26",
      "OAPI20-PS-27", "OAPI20-PS-28", "OAPI20-PS-29", "OAPI20-PS-30", "OAPI20-PS-31",
      "OAPI20-PS-32", "OAPI20-PS-33", "OAPI20-PS-34", "OAPI20-PS-35", "OAPI20-PS-36",
      "OAPI20-PS-37", "OAPI20-PS-38", "OAPI20-PS-39", "OAPI20-PS-40", "OAPI20-PS-41",
      "OAPI20-PS-42", "OAPI20-PS-43", "OAPI20-PS-44", "OAPI20-PS-45", "OAPI20-PS-46",
      "OAPI20-PS-47", "OAPI20-PS-48", "OAPI20-PS-49", "OAPI20-PS-50", "OAPI20-PS-51",
      "OAPI20-PS-52", "OAPI20-PS-53",
      "OAPI20-PS-54", "OAPI20-PS-55", "OAPI20-PS-56", "OAPI20-PS-57", "OAPI20-PS-58",
      "OAPI20-PS-59", "OAPI20-PS-60", "OAPI20-PS-61", "OAPI20-PS-62", "OAPI20-PS-63",
      "OAPI20-PS-64", "OAPI20-PS-65", "OAPI20-PS-66", "OAPI20-PS-67", "OAPI20-PS-68",
      "OAPI20-PS-69", "OAPI20-PS-70", "OAPI20-PS-71", "OAPI20-PS-72", "OAPI20-PS-73",
      "OAPI20-PS-74", "OAPI20-PS-75", "OAPI20-PS-76", "OAPI20-PS-77", "OAPI20-PS-78",
      "OAPI20-PS-79", "OAPI20-PS-80", "OAPI20-PS-81", "OAPI20-PS-82", "OAPI20-PS-83",
      "OAPI20-PS-84", "OAPI20-PS-85", "OAPI20-PS-86", "OAPI20-PS-87", "OAPI20-PS-88",
      "OAPI20-PS-89", "OAPI20-PS-90", "OAPI20-PS-91", "OAPI20-PS-92",
    ]),
  },
  { file: "openapi-3.0.json" },
  { file: "openapi-3.1.json" },
] as const;
const corpora = corpusEntries.map(({ file, ...entry }) => ({
  corpus: parseProcessorCorpus(resolve(corpusRoot, "binding-specs/processor", file), file === "openapi-2.0.json"),
  ...entry,
}));
const fidelityCorpus = JSON.parse(
  readFileSync(resolve(corpusRoot, "invocation-fidelity/openapi.json"), "utf8"),
) as ProcessorScenarioFile;

describe("portable OpenAPI processor scenarios", () => {
  let executed = 0;

  for (const { corpus, wanted } of corpora) {
    for (const scenario of corpus.scenarios) {
      if (wanted && !wanted.has(scenario.id)) continue;
      it(scenario.id, async () => {
        const observation = await runScenario(scenario, corpus);
        try {
          matchProcessorObservation(scenario, observation);
        } catch (error: unknown) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\nobservation: ${JSON.stringify(observation)}`,
            { cause: error },
          );
        }
        executed += 1;
      });
    }
  }

  afterAll(() => {
    expect(corpora.map(({ corpus, wanted }) => wanted?.size ?? corpus.scenarios.length)).toEqual([92, 73, 97]);
    expect(executed).toBe(262);
  });
});

describe("OpenAPI invocation-fidelity scenarios", () => {
  for (const scenario of fidelityCorpus.scenarios) {
    it.skip(`${scenario.id}: pending N10/M7 invocation-fidelity adapter migration`, () => {});
  }
});

async function runScenario(
  scenario: ProcessorScenario,
  scenarioFile: ProcessorScenarioFile,
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
    : new OpenAPIInvoker({ parameterConversion: scenarioParameterConversion(scenario) }).invokeBinding({
      source: invocationSource,
      selector: typeof binding.selector === "string" ? binding.selector : "",
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
    return { disposition: "complete", phase: "completion", data };
  }
  const disposition = terminal.code === CONTEXT_REQUIRED
    ? "context-required"
    : dispatches.length > 0
      ? "error"
      : "refusal";
  return {
    disposition,
    phase: errorPhase(terminal, dispatches.length > 0, scenario.id),
    data: {
      ...data,
      ...(terminal.code === CONTEXT_REQUIRED && terminal.data !== undefined
        ? { context: terminal.data }
        : {}),
      error: {
        code: terminal.code,
        ...(Object.hasOwn(terminal, "data") ? { data: terminal.data } : {}),
      },
    },
  };
}

function parseProcessorCorpus(path: string, preserveNumberTokens: boolean): ProcessorScenarioFile {
  const source = readFileSync(path, "utf8");
  if (!preserveNumberTokens) return JSON.parse(source) as ProcessorScenarioFile;
  type SourceContext = { source?: string };
  const reviver = (_key: string, value: unknown, context?: SourceContext): unknown => {
    if (typeof value === "number" && context?.source && /[.eE]/u.test(context.source)) {
      return new Swagger20Number(context.source);
    }
    return value;
  };
  return JSON.parse(source, reviver) as ProcessorScenarioFile;
}

function scenarioParameterConversion(scenario: ProcessorScenario): ((value: boolean | number) => string) | undefined {
  const raw = scenario.given.configuration?.parameterConversion;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return (value: boolean | number) => {
    const exact = value as unknown;
    const key = exact instanceof Swagger20Number ? exact.lexeme : JSON.stringify(value);
    const converted = (raw as Record<string, unknown>)[key];
    if (typeof converted !== "string") throw new Error(`parameterConversion has no result for ${key}`);
    return converted;
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
      value: observedTextValue(bytes),
      base64: bytesToBase64(bytes),
      byteLength: bytes.byteLength,
    };
  }
  if (body instanceof ArrayBuffer) {
    const bytes = new Uint8Array(body);
    return {
      present: true,
      value: observedTextValue(bytes),
      base64: bytesToBase64(bytes),
      byteLength: bytes.byteLength,
    };
  }
  return { present: true, value: String(body) };
}

function observedTextValue(bytes: Uint8Array): unknown {
  const text = new TextDecoder().decode(bytes);
  try { return JSON.parse(text) as unknown; }
  catch { return text; }
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

function errorPhase(error: InvocationError, dispatched: boolean, _scenarioId: string): ProcessorObservation["phase"] {
  if (dispatched) return "response";
  if (error.code === ERR_SOURCE_LOAD_FAILED) return "load";
  if (error.code === ERR_INVALID_SELECTOR || error.code === ERR_SELECTOR_NOT_FOUND) return "resolution";
  return "pre-dispatch";
}

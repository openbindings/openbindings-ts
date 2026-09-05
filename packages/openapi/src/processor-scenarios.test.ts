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
  ERR_REFUSED,
  ERR_SELECTOR_NOT_FOUND,
  ERR_SOURCE_LOAD_FAILED,
  OperationInvoker,
  operationSignature,
  type InvocationError,
} from "@openbindings/invoke";
import { OpenAPIInvoker, OpenAPISynthesizer } from "./invoker.js";
import { Swagger20Number } from "@openbindings/openapi-client/provider";

if (process.env.OB_CORPUS_REQUIRED === "1" && !process.env.OB_SPEC_CORPUS) {
  throw new Error("OB_CORPUS_REQUIRED=1 requires OB_SPEC_CORPUS");
}
const corpusRoot = process.env.OB_SPEC_CORPUS ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
const corpusEntries: ReadonlyArray<{ file: string; wanted?: ReadonlySet<string> }> = [
  { file: "openapi-2.0.json" },
  { file: "openapi-3.0.json" },
  { file: "openapi-3.1.json" },
  { file: "openapi-3.2.json" },
] as const;
const corpora = corpusEntries.map(({ file, ...entry }) => ({
  corpus: parseProcessorCorpus(resolve(corpusRoot, "binding-specs/processor", file), file === "openapi-2.0.json"),
  ...entry,
}));
const fidelityCorpora = ["openapi-3.0.json", "openapi-3.1.json"].map((file) =>
  JSON.parse(
    readFileSync(resolve(corpusRoot, "invocation-fidelity", file), "utf8"),
  ) as ProcessorScenarioFile,
);

describe("portable OpenAPI processor scenarios", () => {
  let executed = 0;
  const executedByCorpus = corpora.map(() => 0);

  for (const [corpusIndex, { corpus, wanted }] of corpora.entries()) {
    for (const scenario of corpus.scenarios) {
      if (wanted && !wanted.has(scenario.id)) continue;
      it(scenario.id, async () => {
        const observation = await runScenario(scenario, corpus);
        try {
          matchProcessorObservation(scenario, observation, { family: corpus.family });
        } catch (error: unknown) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\nobservation: ${JSON.stringify(observation)}`,
            { cause: error },
          );
        }
        executed += 1;
        executedByCorpus[corpusIndex]! += 1;
      });
    }
  }

  afterAll(() => {
    expect(corpora.map(({ corpus, wanted }) => wanted?.size ?? corpus.scenarios.length)).toEqual([186, 195, 218, 297]);
    expect(executedByCorpus).toEqual([186, 195, 218, 297]);
    expect(executed).toBe(896);
  });
});

describe("OpenAPI invocation-fidelity scenarios", () => {
  for (const corpus of fidelityCorpora) {
    for (const scenario of corpus.scenarios) {
      it(scenario.id, async () => {
        const observation = await runScenario(scenario, corpus);
        try {
          matchProcessorObservation(scenario, observation, { family: corpus.family });
        } catch (error: unknown) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\nobservation: ${JSON.stringify(observation)}`,
            { cause: error },
          );
        }
      });
    }
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
      if (body.byteLength !== undefined) {
        dispatch.bodyByteLength = body.byteLength;
        dispatch.byteLength = body.byteLength;
      }
    }
    dispatches.push(dispatch);

    const response = Array.isArray(peer.responses)
      ? (peer.responses[dispatches.length - 1] ?? {})
      : peer;
    const status = typeof response.status === "number" ? response.status : 599;
    const rawBody = typeof response.bodyBase64 === "string"
      ? base64ToBytes(response.bodyBase64)
      : typeof response.body === "string"
        ? response.body
        : "";
    const responseBody = rawBody === "" && (status === 204 || status === 205 || status === 304)
      ? null
      : rawBody;
    return new Response(responseBody, {
      status,
      headers: (response.headers ?? {}) as Record<string, string>,
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
    : new OpenAPIInvoker({
      parameterConversion: scenarioParameterConversion(scenario),
      requestContentCodings: scenarioRequestContentCodings(scenario.given.runtime),
      responseContentCodings: scenarioResponseContentCodings(scenario.given.runtime),
      requestCharacterEncodings: scenarioRequestCharacterEncodings(scenario.given.runtime),
      responseCharacterEncodings: scenarioResponseCharacterEncodings(scenario.given.runtime),
      ...(scenario.given.runtime?.redirectPolicy === "follow" ? { redirect: "follow" as const } : {}),
    }).invokeBinding({
      source: invocationSource,
      selector: typeof binding.selector === "string" ? binding.selector : "",
      context,
      fetch: fetchMock,
      ...(typeof scenario.given.runtime?.maxDeliveryUnitBytes === "number"
        ? { maxDeliveryUnitBytes: scenario.given.runtime.maxDeliveryUnitBytes }
        : {}),
    });

  if (scenario.given.invocation.inputPresent === true) {
    await call.write(materializedScenarioInput(scenario)).catch(() => {});
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
        code: portableErrorCode(terminal.code, dispatches.length > 0),
        ...(Object.hasOwn(terminal, "data") ? { data: terminal.data } : {}),
      },
    },
  };
}

function materializedScenarioInput(scenario: ProcessorScenario): unknown {
  const input = structuredClone(scenario.given.invocation.input);
  const materializations = scenario.given.invocation.inputMaterializations;
  if (!Array.isArray(materializations)) return input;
  for (const raw of materializations) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${scenario.id}: invalid input materialization`);
    }
    const item = raw as Record<string, unknown>;
    if (
      item.kind !== "unpaired-utf16-code-units"
      || typeof item.path !== "string"
      || !Array.isArray(item.codeUnits)
      || !item.codeUnits.every((unit) => Number.isInteger(unit) && Number(unit) >= 0 && Number(unit) <= 0xffff)
    ) {
      throw new Error(`${scenario.id}: invalid UTF-16 input materialization`);
    }
    setScenarioPointer(
      input,
      item.path,
      String.fromCharCode(...item.codeUnits.map(Number)),
    );
  }
  return input;
}

function setScenarioPointer(root: unknown, pointer: string, replacement: unknown): void {
  if (!pointer.startsWith("/")) throw new Error(`invalid materialization pointer ${JSON.stringify(pointer)}`);
  const tokens = pointer.slice(1).split("/").map((raw) => raw.replaceAll("~1", "/").replaceAll("~0", "~"));
  let current: unknown = root;
  for (const token of tokens.slice(0, -1)) {
    if (current === null || typeof current !== "object") throw new Error(`materialization pointer ${pointer} does not resolve`);
    current = (current as Record<string, unknown>)[token];
  }
  if (current === null || typeof current !== "object") throw new Error(`materialization pointer ${pointer} does not resolve`);
  (current as Record<string, unknown>)[tokens.at(-1)!] = replacement;
}

function scenarioRequestContentCodings(
  runtime: Record<string, unknown> | undefined,
): Record<string, (body: Uint8Array) => Uint8Array> | undefined {
  const declarations = runtime?.requestContentCodings;
  if (declarations === undefined) return undefined;
  if (declarations === null || typeof declarations !== "object" || Array.isArray(declarations)) {
    throw new Error("scenario runtime.requestContentCodings must be an object");
  }
  const result: Record<string, (body: Uint8Array) => Uint8Array> = {};
  for (const [name, implementation] of Object.entries(declarations)) {
    if (implementation !== "reverse") {
      throw new Error(`unknown scenario request content-coding implementation ${JSON.stringify(implementation)}`);
    }
    result[name] = (body) => Uint8Array.from(body).reverse();
  }
  return result;
}

function scenarioResponseContentCodings(
  runtime: Record<string, unknown> | undefined,
): Record<string, (body: Uint8Array) => Uint8Array> | undefined {
  const declarations = runtime?.responseContentCodings;
  if (declarations === undefined) return undefined;
  if (declarations === null || typeof declarations !== "object" || Array.isArray(declarations)) {
    throw new Error("scenario runtime.responseContentCodings must be an object");
  }
  const result: Record<string, (body: Uint8Array) => Uint8Array> = {};
  for (const [name, implementation] of Object.entries(declarations)) {
    if (implementation === "reverse") {
      result[name] = (body) => Uint8Array.from(body).reverse();
      continue;
    }
    if (implementation === "unwrap") {
      result[name] = (body) => {
        const text = new TextDecoder().decode(body);
        const token = name.toLowerCase();
        const prefix = `${token}(`;
        if (!text.startsWith(prefix) || !text.endsWith(")")) {
          throw new Error(`scenario ${JSON.stringify(name)} decoder received malformed wrapper`);
        }
        return new TextEncoder().encode(text.slice(prefix.length, -1));
      };
      continue;
    }
    if (implementation === "identity") {
      result[name] = (body) => Uint8Array.from(body);
      continue;
    }
    if (implementation === "fail") {
      result[name] = () => { throw new Error(`scenario ${JSON.stringify(name)} decoder sentinel`); };
      continue;
    }
    throw new Error(`unknown scenario response content-coding implementation ${JSON.stringify(implementation)}`);
  }
  return result;
}

function scenarioRequestCharacterEncodings(
  runtime: Record<string, unknown> | undefined,
): Record<string, (value: string) => Uint8Array> | undefined {
  const declarations = runtime?.requestCharacterEncodings;
  if (declarations === undefined) return undefined;
  if (declarations === null || typeof declarations !== "object" || Array.isArray(declarations)) {
    throw new Error("scenario runtime.requestCharacterEncodings must be an object");
  }
  const result: Record<string, (value: string) => Uint8Array> = {};
  for (const [name, implementation] of Object.entries(declarations)) {
    if (implementation === "unavailable") continue;
    if (implementation !== "identity") throw new Error(`unknown scenario request character encoding ${JSON.stringify(implementation)}`);
    result[name] = (value) => new TextEncoder().encode(value);
  }
  return result;
}

function scenarioResponseCharacterEncodings(
  runtime: Record<string, unknown> | undefined,
): Record<string, (body: Uint8Array) => string> | undefined {
  const declarations = runtime?.responseCharacterEncodings;
  if (declarations === undefined) return undefined;
  if (declarations === null || typeof declarations !== "object" || Array.isArray(declarations)) {
    throw new Error("scenario runtime.responseCharacterEncodings must be an object");
  }
  const result: Record<string, (body: Uint8Array) => string> = {};
  for (const [name, implementation] of Object.entries(declarations)) {
    if (implementation !== "fail") throw new Error(`unknown scenario response character encoding ${JSON.stringify(implementation)}`);
    result[name] = () => { throw new Error(`scenario ${JSON.stringify(name)} character decoder sentinel`); };
  }
  return result;
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

/**
 * Records the OCTETS this substrate would put on the wire, not the JS string
 * held in the Headers object. A `fetch` header value is a ByteString: each
 * code unit becomes one octet (isomorphic encode). Reading those octets back
 * as UTF-8 makes the observation portable against the Go twin, whose header
 * strings already are their own UTF-8 octets.
 */
function wireHeaderValue(value: string): string {
  const octets = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    // > U+00FF never reaches the wire: the substrate throws on conversion.
    if (unit > 0xff) return value;
    octets[index] = unit;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(octets);
}

function normalizedHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((rawValue, name) => {
    const value = wireHeaderValue(rawValue);
    const canonical = name.split("-").map((part: string) => part.charAt(0).toUpperCase() + part.slice(1)).join("-");
    out[name] = value;
    out[canonical] = value;
  });
  return out;
}

// portableErrorCode presents an SDK error code in the owned portable
// vocabulary the corpus asserts (error-code ownership ruling, 2026-08-31):
// only binding-invoker and operation-invoker codes have portable semantics,
// and no binding specification defines one. The SDK's granular refusal
// codes are documented implementation conventions this runner still reads
// for phase evidence; the portable spelling of every provably-undispatched
// refusal is ERR_REFUSED, and of every other unsuccessful completion
// ERR_EXECUTION_FAILED.
function portableErrorCode(code: string, dispatched: boolean): string {
  switch (code) {
    case CONTEXT_REQUIRED: case "ERR_CANCELLED": case "ERR_FRAME_PROTOCOL":
    case "ERR_TRANSPORT_CLOSED": case ERR_REFUSED: case "ERR_EXECUTION_FAILED":
    case "ERR_OPERATION_NOT_FOUND": case "ERR_BINDING_NOT_FOUND":
    case "ERR_BINDING_SELECTION_REQUIRED": case "ERR_UNKNOWN_SOURCE":
    case "ERR_OPERATION_VALIDATION_FAILED": case "ERR_SCHEMA_UNRESOLVED":
    case "ERR_TRANSFORM_ERROR":
      return code;
    default:
      return dispatched ? "ERR_EXECUTION_FAILED" : ERR_REFUSED;
  }
}

function errorPhase(error: InvocationError, dispatched: boolean, _scenarioId: string): ProcessorObservation["phase"] {
  if (dispatched) return "response";
  if (error.code === ERR_SOURCE_LOAD_FAILED) return "load";
  if (error.code === ERR_INVALID_SELECTOR || error.code === ERR_SELECTOR_NOT_FOUND) return "resolution";
  return "pre-dispatch";
}

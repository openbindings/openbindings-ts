import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_REQUIRED,
  ERR_INVALID_REF,
  ERR_REF_NOT_FOUND,
  ERR_SOURCE_LOAD_FAILED,
  matchProcessorObservation,
  type InvocationError,
  type ProcessorObservation,
  type ProcessorScenario,
  type ProcessorScenarioFile,
} from "@openbindings/sdk";
import { OpenAPIInvoker } from "./invoker.js";

const corpusRoot = process.env.OB_SPEC_CORPUS ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
const corpus = JSON.parse(
  readFileSync(resolve(corpusRoot, "binding-specs/processor/openapi.json"), "utf8"),
) as ProcessorScenarioFile;

describe("portable OpenAPI processor scenarios", () => {
  for (const scenario of corpus.scenarios) {
    it(scenario.id, async () => {
      const observation = await runScenario(scenario);
      expect(() => matchProcessorObservation(scenario, observation)).not.toThrow();
    });
  }
});

async function runScenario(scenario: ProcessorScenario): Promise<ProcessorObservation> {
  const dispatches: Array<Record<string, unknown>> = [];
  const peer = scenario.given.peer ?? {};
  const fetchMock: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const dispatch: Record<string, unknown> = {
      method: init?.method ?? "GET",
      url: input instanceof Request ? input.url : String(input),
      headers: normalizedHeaders(headers),
    };
    const body = await observedBody(init?.body);
    if (body.present) dispatch.body = body.value;
    dispatches.push(dispatch);

    const status = typeof peer.status === "number" ? peer.status : 599;
    const rawBody = typeof peer.body === "string" ? peer.body : "";
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
  const call = new OpenAPIInvoker().invokeBinding({
    source: {
      bindingSpec: corpus.bindingSpec,
      ...(typeof source.location === "string" ? { location: source.location } : {}),
      ...(Object.prototype.hasOwnProperty.call(source, "content") ? { content: source.content } : {}),
    },
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

  const data: Record<string, unknown> = { outputs };
  if (dispatches.length > 0) {
    data.dispatch = dispatches[0];
    data.dispatches = dispatches;
  }
  if (!terminal) {
    const trailer = call.trailer();
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
    data,
  };
}

async function observedBody(
  body: BodyInit | null | undefined,
): Promise<{ present: boolean; value?: unknown }> {
  if (body == null) return { present: false };
  if (typeof body === "string") {
    if (body === "") return { present: false };
    try {
      return { present: true, value: JSON.parse(body) };
    } catch {
      return { present: true, value: body };
    }
  }
  if (body instanceof URLSearchParams) return { present: true, value: body.toString() };
  return { present: true, value: String(body) };
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
  const message = error.message ?? "";
  if (
    error.code === ERR_INVALID_REF || error.code === ERR_REF_NOT_FOUND ||
    message.includes("unflattenable") || message.includes("normalized collision") ||
    message.includes("different locations") || message.includes("case-insensitive")
  ) return "resolution";
  return "pre-dispatch";
}

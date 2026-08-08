import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_REQUIRED,
  ERR_SOURCE_LOAD_FAILED,
  matchProcessorObservation,
  type InvocationError,
  type ProcessorObservation,
  type ProcessorScenario,
  type ProcessorScenarioFile,
} from "@openbindings/sdk";
import { UsageInvoker, type ProcessRequest } from "./index.js";

const root = process.env.OB_SPEC_CORPUS ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
const corpus = JSON.parse(readFileSync(resolve(root, "binding-specs/processor/usage.json"), "utf8")) as ProcessorScenarioFile;
const fidelityCorpus = JSON.parse(
  readFileSync(resolve(root, "invocation-fidelity/usage.json"), "utf8"),
) as ProcessorScenarioFile;

describe("portable Usage processor scenarios", () => {
  for (const scenario of corpus.scenarios) {
    it(scenario.id, async () => {
      const observation = await runScenario(scenario);
      expect(() => matchProcessorObservation(scenario, observation)).not.toThrow();
    });
  }
});

describe("Usage invocation-fidelity scenarios", () => {
  for (const scenario of fidelityCorpus.scenarios) {
    it(scenario.id, async () => {
      const observation = await runScenario(scenario, fidelityCorpus.bindingSpec);
      expect(() => matchProcessorObservation(scenario, observation)).not.toThrow();
    });
  }
});

async function runScenario(
  scenario: ProcessorScenario,
  bindingSpec = corpus.bindingSpec,
): Promise<ProcessorObservation> {
  let dispatch: Record<string, unknown> | undefined;
  const runtimeEncoders = isRecord(scenario.given.runtime?.encoders) ? scenario.given.runtime.encoders : {};
  const encoders: Record<string, (value: unknown) => string> = {};
  for (const [name, fixture] of Object.entries(runtimeEncoders)) {
    encoders[name] = (value) => {
      if (!isRecord(fixture) || JSON.stringify(value) !== JSON.stringify(fixture.input)) throw new Error("encoder input mismatch");
      return String(fixture.output);
    };
  }
  const invoker = new UsageInvoker({
    encoders,
    executor: async (request: ProcessRequest) => {
      dispatch = {
        transport: "process",
        argv: request.argv,
        environment: request.environment,
        ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      };
      const fixture = isRecord(scenario.given.peer?.processResult)
        ? scenario.given.peer.processResult
        : undefined;
      return fixture ? {
        exitCode: typeof fixture.exitCode === "number" ? fixture.exitCode : 0,
        ...(typeof fixture.signal === "string" ? { signal: fixture.signal } : {}),
        ...(typeof fixture.stdoutBase64 === "string" ? { stdout: base64ToBytes(fixture.stdoutBase64) } : {}),
        ...(typeof fixture.stderrBase64 === "string" ? { stderr: base64ToBytes(fixture.stderrBase64) } : {}),
        ...(fixture.stdoutTruncated === true ? { stdoutTruncated: true } : {}),
        ...(fixture.stderrTruncated === true ? { stderrTruncated: true } : {}),
      } : { exitCode: 0 };
    },
    authorizeExecAddress: () => false,
  });
  const context: Record<string, unknown> = {};
  if (scenario.given.configuration) context.configuration = scenario.given.configuration;
  if (isRecord(scenario.given.runtime?.processEnvironment)) context.environment = scenario.given.runtime.processEnvironment;
  const credentials = scenario.given.runtime?.credentials;
  if (isRecord(credentials) && typeof credentials.generic === "string") context.apiKey = credentials.generic;

  const call = invoker.invokeBinding({
    source: {
      bindingSpec,
      ...(typeof scenario.given.source.location === "string" ? { location: scenario.given.source.location } : {}),
      ...(Object.prototype.hasOwnProperty.call(scenario.given.source, "content") ? { content: scenario.given.source.content } : {}),
    },
    ref: typeof scenario.given.binding.ref === "string" ? scenario.given.binding.ref : "",
    context,
  });
  if (scenario.given.invocation.inputPresent) await call.write(scenario.given.invocation.input).catch(() => {});
  else await call.close();

  const outputs: unknown[] = [];
  let terminal: InvocationError | undefined;
  try {
    for await (const output of call.outputs) outputs.push(output);
  } catch (error: unknown) {
    terminal = error as InvocationError;
  }
  const data: Record<string, unknown> = {
    outputs,
    includeReads: [],
    configFileReads: [],
    auxiliaryProcesses: [],
    ...(dispatch ? { dispatch } : {}),
  };
  data.trailer = call.trailer();
  if (!terminal) return { disposition: "complete", phase: "completion", data };
  if (scenario.id.startsWith("USAGE-FI-")) {
    data.error = {
      code: terminal.code,
      message: terminal.message,
      category: terminal.category,
      ...(terminal.effects !== undefined ? { effects: terminal.effects } : {}),
      ...(terminal.details !== undefined ? { details: terminal.details } : {}),
    };
    return { disposition: "error", phase: "completion", data };
  }
  return {
    disposition: terminal.code === CONTEXT_REQUIRED ? "context-required" : "refusal",
    phase: terminal.code === ERR_SOURCE_LOAD_FAILED
      ? "load"
      : terminal.message.includes("omits bin")
        ? "resolution"
        : "pre-dispatch",
    data,
  };
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

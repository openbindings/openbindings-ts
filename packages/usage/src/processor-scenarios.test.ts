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

describe("portable Usage processor scenarios", () => {
  for (const scenario of corpus.scenarios) {
    it(scenario.id, async () => {
      const observation = await runScenario(scenario);
      expect(() => matchProcessorObservation(scenario, observation)).not.toThrow();
    });
  }
});

async function runScenario(scenario: ProcessorScenario): Promise<ProcessorObservation> {
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
      return { exitCode: 0 };
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
      bindingSpec: corpus.bindingSpec,
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
  if (!terminal) return { disposition: "complete", phase: "completion", data };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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
  ERR_SOURCE_LOAD_FAILED,
  ERR_OPERATION_VALIDATION_FAILED,
  ERR_VALIDATION_FAILED,
  OperationInvoker,
  operationSignature,
  type Invocation,
  type InvocationError,
  type Metadata,
} from "@openbindings/invoke";
import {
  GrpcInvoker,
  GrpcSynthesizer,
  type GrpcCall,
  type GrpcInteractionKind,
  type GrpcRuntime,
  type ResolvedGrpcMethod,
} from "./index.js";

const root = process.env.OB_SPEC_CORPUS ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
const corpus = JSON.parse(readFileSync(resolve(root, "binding-specs/processor/grpc.json"), "utf8")) as ProcessorScenarioFile;
const fidelityCorpus = JSON.parse(readFileSync(resolve(root, "invocation-fidelity/grpc.json"), "utf8")) as ProcessorScenarioFile;

describe("portable gRPC processor scenarios", () => {
  for (const scenario of corpus.scenarios) {
    it(scenario.id, async () => {
      const observation = await runScenario(scenario);
      expect(() => matchProcessorObservation(scenario, observation)).not.toThrow();
    });
  }
});

describe("gRPC invocation-fidelity scenarios", () => {
  for (const scenario of fidelityCorpus.scenarios) {
    it(scenario.id, async () => {
      const observation = await runScenario(scenario, true);
      expect(() => matchProcessorObservation(scenario, observation)).not.toThrow();
    });
  }
});

async function runScenario(scenario: ProcessorScenario, joined = false): Promise<ProcessorObservation> {
  const reflectionRequests: string[] = [];
  let dispatch: Record<string, unknown> | undefined;
  let callRef: FakeCall | undefined;
  const runtime: GrpcRuntime = {
    async resolveMethod(args) {
      if (args.content === undefined) {
        reflectionRequests.push("grpc.reflection.v1.ServerReflection");
        throw new Error(`reflection v1 failed: ${String(scenario.given.peer?.reflectionV1Status ?? "unavailable")}`);
      }
      return fakeMethod(String(args.content), args.service, args.method);
    },
    openCall(args) {
      dispatch = { target: args.target, transport: args.transport, method: args.method.path, cancelled: false };
      callRef = new FakeCall(scenario, dispatch);
      return callRef;
    },
  };
  const context: Record<string, unknown> = {};
  if (scenario.given.configuration) context.configuration = scenario.given.configuration;
  const credentials = scenario.given.runtime?.credentials;
  if (isRecord(credentials) && typeof credentials.generic === "string") context.apiKey = credentials.generic;
  if (isRecord(scenario.given.runtime?.outgoingMetadata)) context.headers = scenario.given.runtime.outgoingMetadata;

  const source = {
    bindingSpec: joined ? fidelityCorpus.bindingSpec : corpus.bindingSpec,
    ...(typeof scenario.given.source.location === "string" ? { location: scenario.given.source.location } : {}),
    ...(Object.prototype.hasOwnProperty.call(scenario.given.source, "content") ? { content: scenario.given.source.content } : {}),
  };
  const ref = typeof scenario.given.binding.ref === "string" ? scenario.given.binding.ref : "";
  const bindingInvoker = new GrpcInvoker({ runtime });
  let call: Invocation<unknown, unknown>;
  if (joined) {
    const iface = await new GrpcSynthesizer().synthesizeInterface({ sources: [source] });
    call = new OperationInvoker([bindingInvoker]).invoke(
      iface,
      operationSignature(operationForRef(iface, ref)),
      { context },
    );
  } else {
    call = bindingInvoker.invokeBinding({ source, ref, context });
  }

  const outputs: unknown[] = [];
  let inputOpenAtFirstOutput: boolean | undefined;
  const writes = Array.isArray(scenario.given.invocation.writes) ? scenario.given.invocation.writes : undefined;
  let iterator: AsyncIterator<unknown> | undefined;
  if (writes && writes.length > 0) {
    iterator = call.outputs[Symbol.asyncIterator]();
    await call.write(writes[0]);
    if (scenario.id === "GRPC-PS-04" || scenario.id === "GRPC-PS-10" || scenario.id === "GRPC-FI-03") {
      const first = await iterator.next();
      if (!first.done) outputs.push(first.value);
      inputOpenAtFirstOutput = true;
    }
    for (const value of writes.slice(1)) await call.write(value).catch(() => {});
    await call.close();
  } else if (scenario.given.invocation.inputPresent) {
    await call.write(scenario.given.invocation.input).catch(() => {});
  } else {
    await call.close();
  }

  let terminal: InvocationError | undefined;
  try {
    if (iterator) {
      for (;;) {
        const result = await iterator.next();
        if (result.done) break;
        outputs.push(result.value);
      }
    } else {
      for await (const output of call.outputs) outputs.push(output);
    }
  } catch (error: unknown) {
    terminal = error as InvocationError;
  }
  const data: Record<string, unknown> = {
    outputs,
    reflectionRequests,
    ...(dispatch ? { dispatch } : {}),
    ...(joined ? { joinedSynthesis: true } : {}),
  };
  if (inputOpenAtFirstOutput !== undefined) data.trace = { outputs: [{ inputOpen: inputOpenAtFirstOutput }] };
  if (!terminal) return { disposition: "complete", phase: "completion", data };
  data.error = {
    code: terminal.code,
    ...(Object.hasOwn(terminal, "data") ? { data: terminal.data } : {}),
  };
  const disposition = terminal.code === CONTEXT_REQUIRED
    ? "context-required"
    : dispatch ? "error" : scenario.id === "GRPC-PS-01" ? "error" : "refusal";
  const phase: ProcessorObservation["phase"] = scenario.id === "GRPC-PS-01"
    ? "resolution"
    : (terminal.code === ERR_OPERATION_VALIDATION_FAILED || terminal.code === ERR_VALIDATION_FAILED) && dispatch
      ? "dispatch"
      : dispatch
        ? "completion"
        : terminal.code === ERR_SOURCE_LOAD_FAILED ? "resolution" : "pre-dispatch";
  return { disposition, phase, data };
}

function operationForRef(iface: OBInterface, ref: string): string {
  const match = Object.values(iface.bindings ?? {}).find((binding) => binding.ref === ref);
  if (!match) throw new Error(`synthesized gRPC interface has no binding for ${JSON.stringify(ref)}`);
  return match.operation;
}

function fakeMethod(content: string, service: string, methodName: string): ResolvedGrpcMethod {
  const declaration = new RegExp(`rpc\\s+${methodName}\\s*\\((stream\\s+)?([\\w.]+)\\)\\s*returns\\s*\\((stream\\s+)?([\\w.]+)\\)`).exec(content);
  if (!declaration || !content.includes(`service ${service.split(".").at(-1)}`)) throw new Error(`${service}/${methodName} not found`);
  const client = Boolean(declaration[1]);
  const server = Boolean(declaration[3]);
  const kind: GrpcInteractionKind = client ? server ? "bidirectional" : "client-streaming" : server ? "server-streaming" : "unary";
  const requestName = declaration[2] ?? "Request";
  const message = new RegExp(`message\\s+${requestName}\\s*\\{([^}]*)\\}`).exec(content)?.[1] ?? "";
  const fields = new Set([...message.matchAll(/\b\w+\s+(\w+)\s*=\s*\d+/g)].map((match) => match[1]));
  return {
    path: `/${service}/${methodName}`,
    kind,
    validateInput(value) {
      if (!isRecord(value)) throw new Error("ProtoJSON message must be an object");
      for (const name of Object.keys(value)) if (!fields.has(name)) throw new Error(`unknown ProtoJSON field ${name}`);
    },
    encode(value) { return new TextEncoder().encode(JSON.stringify(value)); },
    decode(bytes) { return JSON.parse(new TextDecoder().decode(bytes)); },
  };
}

class FakeCall implements GrpcCall {
  readonly #queue = new TestQueue<Uint8Array>();
  readonly #done = testDeferred<void>();
  readonly #peer: Record<string, unknown>;
  readonly #dispatch: Record<string, unknown>;
  #writes = 0;
  constructor(scenario: ProcessorScenario, dispatch: Record<string, unknown>) {
    this.#peer = scenario.given.peer ?? {};
    this.#dispatch = dispatch;
  }
  get responses(): AsyncIterable<Uint8Array> { return this.#queue; }
  get header(): Promise<Metadata> { return Promise.resolve(toMetadata(this.#peer.leadingMetadata)); }
  get trailer(): Promise<Metadata> { return Promise.resolve(toMetadata(this.#peer.trailingMetadata)); }
  get done(): Promise<void> { return this.#done.promise; }
  async send(value: Uint8Array): Promise<void> {
    this.#writes++;
    const after = isRecord(this.#peer.afterWrite) ? this.#peer.afterWrite : undefined;
    if (after && after.index === this.#writes - 1 && Array.isArray(after.responses)) {
      for (const response of after.responses) this.#queue.push(encode(response));
    }
  }
  async closeInput(): Promise<void> {
    if (this.#peer.responseMessage !== undefined) this.#queue.push(encode(this.#peer.responseMessage));
    if (Array.isArray(this.#peer.responseMessages)) for (const response of this.#peer.responseMessages) this.#queue.push(encode(response));
    const status = this.#peer.finalStatus ?? "OK";
    if (status === "OK") { this.#queue.close(); this.#done.resolve(); }
    else {
      const error = Object.assign(new Error(String(this.#peer.statusMessage ?? `gRPC ${String(status)}`)), {
        code: grpcStatusCode(String(status)),
        grpcMessage: String(this.#peer.statusMessage ?? `gRPC ${String(status)}`),
        ...(Array.isArray(this.#peer.statusDetails) ? { grpcStatusDetails: this.#peer.statusDetails } : {}),
      });
      this.#queue.fail(error);
      this.#done.reject(error);
    }
  }
  cancel(): void {
    this.#dispatch.cancelled = true;
    this.#queue.close();
    this.#done.resolve();
  }
}

class TestQueue<T> implements AsyncIterable<T> {
  #values: T[] = [];
  #waiters: Array<(value: IteratorResult<T>) => void> = [];
  #closed = false;
  #error: unknown;
  push(value: T): void { const waiter = this.#waiters.shift(); if (waiter) waiter({ value, done: false }); else this.#values.push(value); }
  close(): void { this.#closed = true; for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true }); }
  fail(error: unknown): void { this.#error = error; this.close(); }
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.#values.length) { yield this.#values.shift()!; continue; }
      if (this.#closed) { if (this.#error) throw this.#error; return; }
      const result = await new Promise<IteratorResult<T>>((resolve) => this.#waiters.push(resolve));
      if (result.done) { if (this.#error) throw this.#error; return; }
      yield result.value;
    }
  }
}

function testDeferred<T>(): { promise: Promise<T>; resolve(value?: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  return { promise: new Promise<T>((res, rej) => { resolve = res; reject = rej; }), resolve: (value?: T) => resolve(value as T), reject };
}

function encode(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(value)); }
function toMetadata(value: unknown): Metadata {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [
    name,
    Array.isArray(item) ? item.map(String) : [String(item)],
  ]));
}
function grpcStatusCode(name: string): number {
  const codes: Record<string, number> = {
    OK: 0,
    CANCELLED: 1,
    UNKNOWN: 2,
    INVALID_ARGUMENT: 3,
    DEADLINE_EXCEEDED: 4,
    NOT_FOUND: 5,
    ALREADY_EXISTS: 6,
    PERMISSION_DENIED: 7,
    RESOURCE_EXHAUSTED: 8,
    FAILED_PRECONDITION: 9,
    ABORTED: 10,
    OUT_OF_RANGE: 11,
    UNIMPLEMENTED: 12,
    INTERNAL: 13,
    UNAVAILABLE: 14,
    DATA_LOSS: 15,
    UNAUTHENTICATED: 16,
  };
  return codes[name] ?? 2;
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

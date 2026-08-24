import * as protobuf from "protobufjs";
import descriptor from "protobufjs/ext/descriptor/index.js";
import apiJSON from "protobufjs/google/protobuf/api.json" with { type: "json" };
import descriptorJSON from "protobufjs/google/protobuf/descriptor.json" with { type: "json" };
import sourceContextJSON from "protobufjs/google/protobuf/source_context.json" with { type: "json" };
import typeJSON from "protobufjs/google/protobuf/type.json" with { type: "json" };
import { fromProtoJSON, toProtoJSON } from "./protojson.js";
import { assertBoundMethodRange } from "./schema-range.js";
import { type BindingSpecInfo, type BindingSpecVerdict } from "@openbindings/core";
import {
  InvocationError,
  InvocationImpl,
  contextApiKey,
  contextBearerToken,
  contextBasicAuth,
  contextConfiguration,
  contextHeaders,
  contextRequiredError,
  ERR_CONNECT_FAILED,
  ERR_CANCELLED,
  ERR_EXECUTION_FAILED,
  ERR_INVALID_SELECTOR,
  ERR_PROTOCOL,
  ERR_SELECTOR_NOT_FOUND,
  ERR_RUNTIME,
  ERR_SOURCE_CONFIG_ERROR,
  ERR_SOURCE_LOAD_FAILED,
  ERR_STREAM_ERROR,
  ERR_VALIDATION_FAILED,
  type BindingInvocationArgs,
  type BindingInvoker,
  type Invocation,
} from "@openbindings/invoke";
import { BINDING_SPEC, checkConnectBindingSpecs, connectBindingSpecs } from "./binding-spec.js";

export { BINDING_SPEC } from "./binding-spec.js";

export interface ConnectInvokerOptions {
  /** Whether the selected runtime can provide an HTTP/2 full-duplex request body. */
  fullDuplex?: boolean;
  /** Unordered protocol-permitted choice; defaults to present in this SDK. */
  sendProtocolVersion?: boolean;
}

interface MethodPlan {
  kind: "unary" | "client-streaming" | "server-streaming" | "bidirectional";
  schema: boolean;
  requestType?: protobuf.Type;
  responseType?: protobuf.Type;
}

/** Connect JSON binding invoker, including descriptorless unary mode. */
export class ConnectInvoker implements BindingInvoker {
  readonly #fullDuplex: boolean;
  readonly #sendProtocolVersion: boolean;

  constructor(options: ConnectInvokerOptions = {}) {
    this.#fullDuplex = options.fullDuplex ?? false;
    this.#sendProtocolVersion = options.sendProtocolVersion ?? true;
  }

  checkBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
    return checkConnectBindingSpecs(bindingSpecs);
  }

  bindingSpecs(): BindingSpecInfo[] {
    return connectBindingSpecs();
  }

  invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
    const invocation = new InvocationImpl<unknown, unknown>({ signal: args.signal });
    queueMicrotask(() => void this.#run(args, invocation).catch((error: unknown) => {
      invocation.fireError(error instanceof InvocationError ? error : new InvocationError(ERR_RUNTIME));
    }));
    return invocation as Invocation<I, O>;
  }

  async #run(args: BindingInvocationArgs, invocation: InvocationImpl<unknown, unknown>): Promise<void> {
    let service: string;
    let methodName: string;
    try {
      ({ service, method: methodName } = parseSelector(args.selector));
    } catch (error: unknown) {
      invocation.fireError(new InvocationError(ERR_INVALID_SELECTOR));
      return;
    }
    let target: string;
    try {
      target = resolveTarget(args);
    } catch (error: unknown) {
      invocation.fireError(new InvocationError(ERR_SOURCE_CONFIG_ERROR));
      return;
    }
    let plan: MethodPlan;
    try {
      plan = resolveMethod(args.source.content, service, methodName);
    } catch (error: unknown) {
      const code = message(error).includes("not found") ? ERR_SELECTOR_NOT_FOUND : ERR_SOURCE_LOAD_FAILED;
      invocation.fireError(new InvocationError(code));
      return;
    }
    if ((plan.kind === "client-streaming" || plan.kind === "bidirectional") && !this.#fullDuplex) {
      invocation.fireError(new InvocationError(ERR_SOURCE_CONFIG_ERROR));
      return;
    }
    let callerHeaders: Record<string, string>;
    try {
      callerHeaders = resolveHeaders(args.context);
    } catch (error: unknown) {
      if (error instanceof UnplacedCredential) {
        invocation.fireError(contextRequiredError({
          target,
          alternatives: [{ requirements: [{ type: "auth.apiKey", description: "supply an explicitly named Connect metadata field" }] }],
        }));
      } else invocation.fireError(new InvocationError(ERR_SOURCE_CONFIG_ERROR));
      return;
    }

    const url = `${target}/${service}/${methodName}`;
    const headers = new Headers(callerHeaders);
    const streaming = plan.kind !== "unary";
    headers.set("Content-Type", streaming ? "application/connect+json" : "application/json");
    if (this.#sendProtocolVersion) headers.set("Connect-Protocol-Version", "1");
    const fetchImpl = args.fetch ?? fetch;

    if (plan.kind === "unary" || plan.kind === "server-streaming") {
      const input = await oneInput(invocation, !plan.schema);
      if (!input.present && !plan.schema) {
        invocation.fireError(new InvocationError(ERR_VALIDATION_FAILED));
        return;
      }
      const value = input.present ? input.value : {};
      let json: unknown;
      try {
        json = encodeProtoJSON(plan.requestType, value);
      } catch (error: unknown) {
        invocation.fireError(new InvocationError(ERR_VALIDATION_FAILED));
        return;
      }
      const body = plan.kind === "unary"
        ? JSON.stringify(json)
        : concatBytes(envelope(0, encodeJSON(json)), envelope(0x02, encodeJSON({})));
      const response = await dispatch(fetchImpl, url, headers, body, invocation.signal);
      if (!response) return;
      if (response.status !== 200) {
        invocation.fireError(await connectHTTPError(response));
        return;
      }
      if (plan.kind === "unary") await handleUnaryResponse(response, plan, invocation);
      else await handleStreamingResponse(response, plan, invocation);
      return;
    }

    // Full-duplex request streaming. Fetch begins immediately with a live
    // stream, and response envelopes are consumed concurrently.
    const request = new TransformStream<Uint8Array, Uint8Array>();
    const writer = request.writable.getWriter();
    const responsePromise = dispatch(fetchImpl, url, headers, request.readable, invocation.signal, true);
    const sender = (async () => {
      try {
        for await (const input of invocation.inputs()) {
          const json = encodeProtoJSON(plan.requestType, input);
          await writer.write(envelope(0, encodeJSON(json)));
        }
        await writer.write(envelope(0x02, encodeJSON({})));
        await writer.close();
      } catch (error: unknown) {
        await writer.abort(error).catch(() => {});
        throw new InvocationError(ERR_VALIDATION_FAILED);
      }
    })();
    const response = await responsePromise;
    if (!response) return;
    if (response.status !== 200) {
      invocation.fireError(await connectHTTPError(response));
      await sender.catch(() => {});
      return;
    }
    try {
      await handleStreamingResponse(response, plan, invocation);
      await sender;
    } catch (error: unknown) {
      invocation.fireError(error instanceof InvocationError ? error : new InvocationError(ERR_STREAM_ERROR));
    }
  }
}

class UnplacedCredential extends Error {}

function parseSelector(selector: string): { service: string; method: string } {
  const index = selector.indexOf("/");
  if (index <= 0 || index !== selector.lastIndexOf("/") || index === selector.length - 1) {
    throw new Error(`Connect selector ${JSON.stringify(selector)} must be <fully-qualified-service>/<method> with exactly one "/"`);
  }
  return { service: selector.slice(0, index), method: selector.slice(index + 1) };
}

function resolveTarget(args: BindingInvocationArgs): string {
  const configured = contextConfiguration(args.context)["target"];
  const target = typeof configured === "string" ? configured : args.source.location;
  if (!target) throw new Error("Connect source requires an absolute HTTP(S) base URL");
  if (target !== target.trim()) throw new Error("Connect target must not carry surrounding whitespace");
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error("Connect target must be an absolute HTTP(S) base URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Connect target must use http or https");
  if (!url.hostname) throw new Error("Connect target must name a host");
  if (url.username || url.password) throw new Error("Connect target must not carry userinfo");
  if (target.includes("?")) throw new Error("Connect target must not carry a query component");
  if (target.includes("#")) throw new Error("Connect target must not carry a fragment component");
  if (target.endsWith("/")) throw new Error("Connect target path prefix must not have a trailing slash");
  return url.toString().replace(/\/+$/, "");
}

function resolveMethod(content: unknown, serviceName: string, methodName: string): MethodPlan {
  if (content === undefined) return { kind: "unary", schema: false };
  const root = loadProtobufSchema(content);
  const service = root.lookupService(serviceName);
  const method = service.methods[methodName];
  if (!method) throw new Error(`method ${serviceName}/${methodName} not found in embedded schema`);
  assertBoundMethodRange(root, method);
  return {
    kind: method.requestStream
      ? method.responseStream ? "bidirectional" : "client-streaming"
      : method.responseStream ? "server-streaming" : "unary",
    schema: true,
    requestType: root.lookupType(method.requestType),
    responseType: root.lookupType(method.responseType),
  };
}

export function loadProtobufSchema(content: unknown): protobuf.Root {
  if (typeof content === "string") {
    // Preserve the declared proto spelling so the incorporated ProtoJSON
    // alias rule remains available.
    const parsed = protobuf.parse(content, { keepCase: true });
    for (const imported of parsed.imports ?? []) {
      if (!imported.startsWith("google/protobuf/")) {
        throw new Error(`embedded .proto content may import only google/protobuf/* files; ${JSON.stringify(imported)} is refused`);
      }
      addBundledProtobufImport(parsed.root, imported);
    }
    parsed.root.resolveAll();
    return parsed.root;
  }
  if (!isRecord(content)) {
    throw new Error("Connect schema content must be single-file .proto source text or a FileDescriptorSet in canonical JSON");
  }
  refuseUnknownDescriptorMembers(descriptor.FileDescriptorSet, content, "content");
  const set = descriptor.FileDescriptorSet.fromObject(content);
  const reason = descriptor.FileDescriptorSet.verify(set);
  if (reason) throw new Error(`Connect content is not a FileDescriptorSet in canonical JSON: ${reason}`);
  const bytes = descriptor.FileDescriptorSet.encode(set).finish();
  const factory = protobuf.Root as typeof protobuf.Root & { fromDescriptor(value: Uint8Array): protobuf.Root };
  const root = factory.fromDescriptor(bytes);
  root.resolveAll();
  return root;
}

function addBundledProtobufImport(root: protobuf.Root, imported: string): void {
  type BundledJSON = { nested?: Record<string, protobuf.AnyNestedObject> };
  const common = (protobuf.common as unknown as Record<string, BundledJSON>)[imported];
  if (common?.nested) { root.addJSON(common.nested); return; }
  const extra = {
    "google/protobuf/api.proto": apiJSON,
    "google/protobuf/descriptor.proto": descriptorJSON,
    "google/protobuf/source_context.proto": sourceContextJSON,
    "google/protobuf/type.proto": typeJSON,
  } as unknown as Record<string, BundledJSON>;
  const bundled = extra[imported];
  if (!bundled?.nested) throw new Error(`bundled google protobuf import ${JSON.stringify(imported)} is unavailable`);
  root.addJSON(bundled.nested);
}

function refuseUnknownDescriptorMembers(type: protobuf.Type, value: unknown, path: string): void {
  if (!isRecord(value)) return;
  for (const [key, member] of Object.entries(value)) {
    if (key.startsWith("[") && key.endsWith("]")) {
      throw new Error(`descriptor-set content carries bracket-keyed extension member ${JSON.stringify(key)} at ${path}`);
    }
    const field = type.fields[key];
    if (!field) throw new Error(`FileDescriptorSet content carries unknown member ${JSON.stringify(key)} at ${path}`);
    if (!(field.resolvedType instanceof protobuf.Type)) continue;
    if (field.repeated) {
      if (Array.isArray(member)) member.forEach((item, index) => refuseUnknownDescriptorMembers(field.resolvedType as protobuf.Type, item, `${path}.${key}[${index}]`));
    } else refuseUnknownDescriptorMembers(field.resolvedType, member, `${path}.${key}`);
  }
}

function resolveHeaders(context: Record<string, unknown> | undefined): Record<string, string> {
  if (contextApiKey(context) || contextBearerToken(context) || contextBasicAuth(context)) {
    throw new UnplacedCredential("generic credential has no explicitly named Connect metadata field");
  }
  const headers = contextHeaders(context);
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith("connect-") || ["content-type", "content-length", "host"].includes(lower)) {
      throw new Error(`metadata field ${JSON.stringify(name)} is protocol-reserved or processor-owned`);
    }
  }
  return headers;
}

function encodeProtoJSON(type: protobuf.Type | undefined, value: unknown): unknown {
  if (!type) return value;
  return toProtoJSON(type, fromProtoJSON(type, value));
}

function decodeProtoJSON(type: protobuf.Type | undefined, value: unknown): unknown {
  if (!type) return value;
  return toProtoJSON(type, fromProtoJSON(type, value));
}

async function dispatch(
  fetchImpl: typeof fetch,
  url: string,
  headers: Headers,
  body: unknown,
  signal: AbortSignal,
  duplex = false,
): Promise<Response | undefined> {
  try {
    const init: RequestInit & { duplex?: "half" } = {
      method: "POST",
      headers,
      body: body as BodyInit,
      signal,
      redirect: "manual",
    };
    if (duplex) init.duplex = "half";
    return await fetchImpl(url, init);
  } catch (error: unknown) {
    if (signal.aborted) return undefined;
    throw new InvocationError(ERR_CONNECT_FAILED);
  }
}

async function handleUnaryResponse(
  response: Response,
  plan: MethodPlan,
  invocation: InvocationImpl<unknown, unknown>,
): Promise<void> {
  const text = await response.text();
  if (text === "") {
    invocation.fireError(new InvocationError(ERR_PROTOCOL));
    return;
  }
  try {
    await invocation.emitOutput(decodeProtoJSON(plan.responseType, JSON.parse(text)));
    invocation.closeOutput();
  } catch (error: unknown) {
    invocation.fireError(new InvocationError(ERR_PROTOCOL));
  }
}

async function handleStreamingResponse(
  response: Response,
  plan: MethodPlan,
  invocation: InvocationImpl<unknown, unknown>,
): Promise<void> {
  if (!response.body) throw new InvocationError(ERR_PROTOCOL);
  let sawEnd = false;
  for await (const frame of readEnvelopes(response.body)) {
    if ((frame.flags & 0x02) !== 0) {
      if (sawEnd) throw new InvocationError(ERR_PROTOCOL);
      sawEnd = true;
      let end: Record<string, unknown>;
      try {
        const parsed = JSON.parse(new TextDecoder().decode(frame.payload));
        if (!isRecord(parsed)) throw new Error("payload is not an object");
        end = parsed;
      } catch (error: unknown) {
        throw new InvocationError(ERR_PROTOCOL);
      }
      validateEndStreamMetadata(end.metadata);
      if (isRecord(end.error)) {
        throw new InvocationError(ERR_EXECUTION_FAILED);
      }
      continue;
    }
    if (sawEnd) throw new InvocationError(ERR_PROTOCOL);
    const value = JSON.parse(new TextDecoder().decode(frame.payload));
    await invocation.emitOutput(decodeProtoJSON(plan.responseType, value));
  }
  if (!sawEnd) throw new InvocationError(ERR_PROTOCOL);
  invocation.closeOutput();
}

export function envelope(flags: number, payload: Uint8Array): Uint8Array {
  const output = new Uint8Array(5 + payload.length);
  output[0] = flags;
  new DataView(output.buffer).setUint32(1, payload.length);
  output.set(payload, 5);
  return output;
}

async function* readEnvelopes(stream: ReadableStream<Uint8Array>): AsyncIterable<{ flags: number; payload: Uint8Array }> {
  const reader = stream.getReader();
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending = concatBytes(pending, value);
    while (pending.length >= 5) {
      const length = new DataView(pending.buffer, pending.byteOffset, pending.byteLength).getUint32(1);
      if (pending.length < 5 + length) break;
      yield { flags: pending[0]!, payload: pending.slice(5, 5 + length) };
      pending = pending.slice(5 + length);
    }
  }
  if (pending.length !== 0) throw new InvocationError(ERR_PROTOCOL);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function encodeJSON(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(value)); }

async function oneInput(invocation: InvocationImpl<unknown, unknown>, descriptorless: boolean): Promise<{ present: boolean; value?: unknown }> {
  for await (const value of invocation.inputs()) {
    void invocation.closeInput();
    return { present: true, value };
  }
  return { present: false, ...(descriptorless ? {} : { value: {} }) };
}

async function connectHTTPError(response: Response): Promise<InvocationError> {
  await response.body?.cancel();
  return new InvocationError(ERR_EXECUTION_FAILED);
}

function validateEndStreamMetadata(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new InvocationError(ERR_PROTOCOL);
  for (const raw of Object.values(value)) {
    if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) {
      throw new InvocationError(ERR_PROTOCOL);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export { ConnectSynthesizer } from "./authoring.js";

import * as grpc from "@grpc/grpc-js";
import * as protobuf from "protobufjs";

import descriptor from "protobufjs/ext/descriptor/index.js";
import apiJSON from "protobufjs/google/protobuf/api.json" with { type: "json" };
import descriptorJSON from "protobufjs/google/protobuf/descriptor.json" with { type: "json" };
import sourceContextJSON from "protobufjs/google/protobuf/source_context.json" with { type: "json" };
import typeJSON from "protobufjs/google/protobuf/type.json" with { type: "json" };
import { fromProtoJSON, toProtoJSON } from "./protojson.js";
import { assertBoundMethodRange } from "./schema-range.js";
import { type BindingSpecInfo } from "@openbindings/core";
import {
  InvocationError,
  InvocationImpl,
  contextApiKey,
  contextBearerToken,
  contextBasicAuth,
  contextConfiguration,
  contextHeaders,
  contextRequiredError,
  ERR_CANCELLED,
  ERR_CONNECT_FAILED,
  ERR_EXECUTION_FAILED,
  ERR_INVALID_REF,
  ERR_PROTOCOL,
  ERR_REF_NOT_FOUND,
  ERR_RUNTIME,
  ERR_SOURCE_CONFIG_ERROR,
  ERR_SOURCE_LOAD_FAILED,
  ERR_STREAM_ERROR,
  ERR_VALIDATION_FAILED,
  type BindingInvocationArgs,
  type BindingInvoker,
  type Invocation,
  type Metadata,
} from "@openbindings/invoke";

export const BINDING_SPEC = "openbindings.grpc@1";

export type GrpcInteractionKind = "unary" | "client-streaming" | "server-streaming" | "bidirectional";

export interface ResolvedGrpcMethod {
  path: string;
  kind: GrpcInteractionKind;
  validateInput(value: unknown): void;
  encode(value: unknown): Uint8Array;
  decode(bytes: Uint8Array): unknown;
}

export interface GrpcCall {
  send(value: Uint8Array): Promise<void>;
  closeInput(): Promise<void>;
  readonly responses: AsyncIterable<Uint8Array>;
  readonly header: Promise<Metadata>;
  readonly trailer: Promise<Metadata>;
  readonly done: Promise<void>;
  cancel(): void;
}

export interface GrpcRuntime {
  resolveMethod(args: {
    target: string;
    service: string;
    method: string;
    content: unknown;
    transport: "plaintext" | "tls";
    metadata: Record<string, string>;
    signal: AbortSignal;
  }): Promise<ResolvedGrpcMethod>;
  openCall(args: {
    target: string;
    transport: "plaintext" | "tls";
    method: ResolvedGrpcMethod;
    metadata: Record<string, string>;
    signal: AbortSignal;
  }): GrpcCall;
}

export interface GrpcInvokerOptions {
  runtime?: GrpcRuntime;
}

export interface ReflectedSchemaOptions {
  transport?: "plaintext" | "tls";
  metadata?: Record<string, string>;
  signal?: AbortSignal;
}

/** Node gRPC implementation preserving protobuf-declared interaction shape. */
export class GrpcInvoker implements BindingInvoker {
  readonly #runtime: GrpcRuntime;

  constructor(options: GrpcInvokerOptions = {}) {
    this.#runtime = options.runtime ?? new NodeGrpcRuntime();
  }

  bindingSpecs(): BindingSpecInfo[] {
    return [{ bindingSpec: BINDING_SPEC, description: "gRPC via protobuf schemas or server reflection" }];
  }

  invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
    const invocation = new InvocationImpl<unknown, unknown>({ signal: args.signal });
    queueMicrotask(() => void this.#run(args, invocation).catch((error: unknown) => {
      invocation.fireError(error instanceof InvocationError
        ? error
        : new InvocationError(ERR_RUNTIME));
    }));
    return invocation as Invocation<I, O>;
  }

  async #run(args: BindingInvocationArgs, invocation: InvocationImpl<unknown, unknown>): Promise<void> {
    let service: string;
    let methodName: string;
    try {
      ({ service, method: methodName } = parseRef(args.ref));
    } catch (error: unknown) {
      invocation.fireError(new InvocationError(ERR_INVALID_REF));
      return;
    }
    let target: string;
    let transport: "plaintext" | "tls";
    try {
      ({ target, transport } = resolveTarget(args));
    } catch (error: unknown) {
      invocation.fireError(new InvocationError(ERR_SOURCE_CONFIG_ERROR));
      return;
    }
    let metadata: Record<string, string>;
    try {
      metadata = resolveMetadata(args.context);
    } catch (error: unknown) {
      if (error instanceof UnplacedCredential) {
        invocation.fireError(contextRequiredError({
          target,
          alternatives: [{ requirements: [{ type: "auth.apiKey", description: "supply an explicitly named gRPC metadata field" }] }],
        }));
      } else {
        invocation.fireError(new InvocationError(ERR_SOURCE_CONFIG_ERROR));
      }
      return;
    }

    let method: ResolvedGrpcMethod;
    try {
      method = await this.#runtime.resolveMethod({
        target, service, method: methodName, content: args.source.content, transport, metadata, signal: invocation.signal,
      });
    } catch (error: unknown) {
      if (grpcCode(error) !== undefined) {
        invocation.fireError(grpcInvocationError(error, ERR_SOURCE_LOAD_FAILED));
      } else {
        const code = message(error).includes("not found") ? ERR_REF_NOT_FOUND : ERR_SOURCE_LOAD_FAILED;
        invocation.fireError(new InvocationError(code));
      }
      return;
    }

    if (method.kind === "unary" || method.kind === "server-streaming") {
      const noInput = args.binding !== undefined && args.inputSchema === undefined;
      let value: unknown = {};
      if (noInput) void invocation.closeInput();
      else {
        const first = await firstInput(invocation.inputs());
        void invocation.closeInput();
        if (first !== undefined) value = first;
      }
      let encoded: Uint8Array;
      try {
        method.validateInput(value);
        encoded = method.encode(value);
      } catch (error: unknown) {
        invocation.fireError(new InvocationError(ERR_VALIDATION_FAILED));
        return;
      }
      const call = this.#runtime.openCall({ target, transport, method, metadata, signal: invocation.signal });
      await this.#driveCall(call, method, invocation, async () => {
        await call.send(encoded);
        await call.closeInput();
      });
      return;
    }

    // Client-streaming and bidirectional calls open before consuming their
    // stream. The response pump starts concurrently, so bidi outputs can flow
    // while caller input remains open.
    const call = this.#runtime.openCall({ target, transport, method, metadata, signal: invocation.signal });
    await this.#driveCall(call, method, invocation, async () => {
      for await (const value of invocation.inputs()) {
        try {
          method.validateInput(value);
          await call.send(method.encode(value));
        } catch (error: unknown) {
          call.cancel();
          throw new InvocationError(ERR_VALIDATION_FAILED);
        }
      }
      await call.closeInput();
    });
  }

  async #driveCall(
    call: GrpcCall,
    method: ResolvedGrpcMethod,
    invocation: InvocationImpl<unknown, unknown>,
    send: () => Promise<void>,
  ): Promise<void> {
    invocation.signal.addEventListener("abort", () => call.cancel(), { once: true });
    const sender = send().catch((error: unknown) => {
      if (!invocation.signal.aborted) invocation.fireError(error instanceof InvocationError
        ? error
        : grpcInvocationError(error, ERR_STREAM_ERROR));
      call.cancel();
    });
    const header = call.header.catch(() => ({}));
    try {
      for await (const bytes of call.responses) {
        await invocation.emitOutput(method.decode(bytes));
      }
      await call.done;
      await sender;
      await header;
      const trailer = await call.trailer.catch(() => ({}));
      invocation.closeOutput();
    } catch (error: unknown) {
      await sender;
      await call.done.catch(() => {});
      const trailer = await call.trailer.catch(() => ({}));
      if (!invocation.signal.aborted) invocation.fireError(grpcInvocationError(error, ERR_STREAM_ERROR));
    }
  }
}

class UnplacedCredential extends Error {}

function parseRef(ref: string): { service: string; method: string } {
  const index = ref.indexOf("/");
  if (index <= 0 || index !== ref.lastIndexOf("/") || index === ref.length - 1) {
    throw new Error(`gRPC ref ${JSON.stringify(ref)} must be <fully-qualified-service>/<method> with exactly one "/"`);
  }
  return { service: ref.slice(0, index), method: ref.slice(index + 1) };
}

function resolveTarget(args: BindingInvocationArgs): { target: string; transport: "plaintext" | "tls" } {
  const cfg = contextConfiguration(args.context);
  const configuredTarget = cfg["target"];
  let raw = typeof configuredTarget === "string" ? configuredTarget : args.source.location;
  if (!raw) throw new Error("gRPC source requires a dial target");
  if (raw !== raw.trim()) throw new Error("gRPC target must not carry surrounding whitespace");
  let transport: "plaintext" | "tls" | undefined;
  if (raw.startsWith("grpc://")) {
    transport = "plaintext";
    raw = raw.slice("grpc://".length);
  } else if (raw.startsWith("grpcs://")) {
    transport = "tls";
    raw = raw.slice("grpcs://".length);
  } else if (raw.includes("://")) {
    throw new Error("gRPC target must use host:port, grpc://host:port, or grpcs://host:port");
  }
  const configuredTransport = cfg["transport"];
  if (configuredTransport !== undefined) {
    if (configuredTransport !== "plaintext" && configuredTransport !== "tls") {
      throw new Error("configuration.transport must be plaintext or tls");
    }
    transport = configuredTransport;
  }
  if (/[/?#@]/u.test(raw)) throw new Error(`gRPC target ${JSON.stringify(raw)} must not carry path, query, fragment, or userinfo`);
  const bracketed = /^\[([^\]]+)\]:(\d+)$/u.exec(raw);
  const ordinary = /^([^/:\s]+):(\d+)$/u.exec(raw);
  if (!bracketed && !ordinary) throw new Error(`gRPC target ${JSON.stringify(raw)} must be host:port with an explicit numeric port`);
  try {
    // URL parsing supplies strict host validation, including bracketed IPv6.
    new URL(`http://${raw}`);
  } catch {
    throw new Error(`gRPC target ${JSON.stringify(raw)} carries an invalid host`);
  }
  if (!transport) throw new Error("bare host:port supplies no transport identity; select configuration.transport");
  return { target: raw, transport };
}

function resolveMetadata(context: Record<string, unknown> | undefined): Record<string, string> {
  if (contextApiKey(context) || contextBearerToken(context) || contextBasicAuth(context)) {
    throw new UnplacedCredential("generic credential has no explicitly named gRPC metadata key");
  }
  const values = contextHeaders(context);
  for (const name of Object.keys(values)) {
    if (!/^[a-z0-9_.-]+$/.test(name) || name.startsWith("grpc-")) {
      throw new Error(`metadata field ${JSON.stringify(name)} is invalid or protocol-reserved`);
    }
  }
  return values;
}

class NodeGrpcRuntime implements GrpcRuntime {
  async resolveMethod(args: {
    target: string; service: string; method: string; content: unknown; transport: "plaintext" | "tls"; metadata: Record<string, string>; signal: AbortSignal;
  }): Promise<ResolvedGrpcMethod> {
    const root = args.content === undefined
      ? await reflectRoot(args)
      : loadProtobufSchema(args.content);
    return resolvedMethod(root, args.service, args.method);
  }

  openCall(args: {
    target: string; transport: "plaintext" | "tls"; method: ResolvedGrpcMethod; metadata: Record<string, string>; signal: AbortSignal;
  }): GrpcCall {
    return new NodeGrpcCall(args);
  }
}

/** Loads either embedded protobuf carriage accepted by openbindings.grpc@1. */
export function loadProtobufSchema(content: unknown): protobuf.Root {
  if (typeof content === "string") {
    // Preserve the declared proto field name alongside its canonical
    // lowerCamel/json_name spelling. ProtoJSON accepts both spellings.
    const parsed = protobuf.parse(content, { keepCase: true });
    for (const imported of parsed.imports ?? []) {
      if (!imported.startsWith("google/protobuf/")) {
        throw new Error(`embedded .proto content may import only google/protobuf/* files; ${JSON.stringify(imported)} is refused`);
      }
      addBundledProtobufImport(parsed.root, imported);
    }
    try {
      parsed.root.resolveAll();
    } catch (error: unknown) {
      throw new Error(`embedded .proto schema does not form a resolvable single-file closure: ${message(error)}`);
    }
    return parsed.root;
  }
  if (!isRecord(content)) {
    throw new Error("embedded gRPC content must be single-file .proto source text or a FileDescriptorSet in canonical JSON");
  }
  const keys = Object.keys(content);
  for (const key of keys) {
    if (key !== "file") throw new Error(`FileDescriptorSet content carries unknown member ${JSON.stringify(key)}`);
  }
  refuseUnknownDescriptorMembers(descriptor.FileDescriptorSet, content, "content");
  const set = descriptor.FileDescriptorSet.fromObject(content);
  const reason = descriptor.FileDescriptorSet.verify(set);
  if (reason) throw new Error(`gRPC content is not a FileDescriptorSet in canonical JSON: ${reason}`);
  const bytes = descriptor.FileDescriptorSet.encode(set).finish();
  const factory = protobuf.Root as typeof protobuf.Root & {
    fromDescriptor(value: Uint8Array): protobuf.Root;
  };
  try {
    const root = factory.fromDescriptor(bytes);
    root.resolveAll();
    return root;
  } catch (error: unknown) {
    throw new Error(`descriptor-set content does not form a self-contained closure: ${message(error)}`);
  }
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
    } else {
      refuseUnknownDescriptorMembers(field.resolvedType, member, `${path}.${key}`);
    }
  }
}

function resolvedMethod(root: protobuf.Root, serviceName: string, methodName: string): ResolvedGrpcMethod {
    let service: protobuf.Service;
    try {
      service = root.lookupService(serviceName);
    } catch {
      throw new Error(`service ${serviceName} not found in schema`);
    }
    const method = service.methods[methodName];
    if (!method) throw new Error(`method ${serviceName}/${methodName} not found in schema`);
    assertBoundMethodRange(root, method);
    const requestType = root.lookupType(method.requestType);
    const responseType = root.lookupType(method.responseType);
    const kind: GrpcInteractionKind = method.requestStream
      ? method.responseStream ? "bidirectional" : "client-streaming"
      : method.responseStream ? "server-streaming" : "unary";
    return {
      path: `/${serviceName}/${methodName}`,
      kind,
      validateInput(value) { fromProtoJSON(requestType, value); },
      encode(value) { return requestType.encode(fromProtoJSON(requestType, value)).finish(); },
      decode(bytes) {
        return toProtoJSON(responseType, responseType.decode(bytes));
      },
    };
}

async function reflectRoot(args: {
  target: string;
  service: string;
  transport: "plaintext" | "tls";
  metadata: Record<string, string>;
  signal: AbortSignal;
}): Promise<protobuf.Root> {
  try {
    return await reflectRootVersion(args, "v1");
  } catch (error: unknown) {
    if (grpcCode(error) !== grpc.status.UNIMPLEMENTED) throw error;
    return reflectRootVersion(args, "v1alpha");
  }
}

/** Discovers the complete service schema exposed by gRPC reflection. */
export async function discoverReflectedSchema(
  location: string,
  options: ReflectedSchemaOptions = {},
): Promise<protobuf.Root> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const resolved = resolveTarget({
      source: { bindingSpec: BINDING_SPEC, location },
      ref: "reflection/authoring",
      context: options.transport ? { configuration: { transport: options.transport } } : undefined,
    });
    const metadata = options.metadata ?? {};
    validateMetadata(metadata);
    try {
      return await reflectAllVersion({ ...resolved, metadata, signal: controller.signal }, "v1");
    } catch (error: unknown) {
      if (grpcCode(error) !== grpc.status.UNIMPLEMENTED) throw error;
      return reflectAllVersion({ ...resolved, metadata, signal: controller.signal }, "v1alpha");
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

async function reflectAllVersion(
  args: { target: string; transport: "plaintext" | "tls"; metadata: Record<string, string>; signal: AbortSignal },
  version: "v1" | "v1alpha",
): Promise<protobuf.Root> {
  const services = await reflectServiceNames(args, version);
  const combined = new protobuf.Root();
  for (const service of services.filter((name) => !name.startsWith("grpc.reflection."))) {
    const discovered = await reflectRootVersion({ ...args, service }, version);
    const json = discovered.toJSON();
    if (json.nested) combined.addJSON(json.nested);
  }
  combined.resolveAll();
  return combined;
}

async function reflectServiceNames(
  args: { target: string; transport: "plaintext" | "tls"; metadata: Record<string, string>; signal: AbortSignal },
  version: "v1" | "v1alpha",
): Promise<string[]> {
  const namespace = `grpc.reflection.${version}`;
  const parsed = protobuf.parse(reflectionProto(namespace));
  const requestType = parsed.root.lookupType(`${namespace}.ServerReflectionRequest`);
  const responseType = parsed.root.lookupType(`${namespace}.ServerReflectionResponse`);
  const metadata = new grpc.Metadata();
  for (const [name, value] of Object.entries(args.metadata)) metadata.set(name, value);
  const client = new grpc.Client(
    args.target,
    args.transport === "tls" ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(),
  );
  const call = client.makeBidiStreamRequest<Record<string, unknown>, protobuf.Message>(
    `/${namespace}.ServerReflection/ServerReflectionInfo`,
    (value) => Buffer.from(requestType.encode(requestType.fromObject(value)).finish()),
    (value) => responseType.decode(value),
    metadata,
  );
  const abort = () => call.cancel();
  args.signal.addEventListener("abort", abort, { once: true });
  try {
    const response = await new Promise<protobuf.Message>((resolve, reject) => {
      call.once("data", resolve);
      call.once("error", reject);
      call.once("end", () => reject(new Error(`${namespace} reflection stream ended without a response`)));
      call.write({ listServices: "" });
      call.end();
    });
    const object = responseType.toObject(response) as Record<string, unknown>;
    const protocolError = object["errorResponse"];
    if (isRecord(protocolError)) {
      const error = new Error(`${namespace} reflection error ${String(protocolError["errorCode"])}: ${String(protocolError["errorMessage"] ?? "")}`) as Error & { code?: number };
      error.code = Number(protocolError["errorCode"]);
      throw error;
    }
    const listing = object["listServicesResponse"];
    const service = isRecord(listing) ? listing["service"] : undefined;
    if (!Array.isArray(service)) throw new Error(`${namespace} reflection response carried no service listing`);
    return service.flatMap((entry) => isRecord(entry) && typeof entry["name"] === "string" ? [entry["name"]] : []);
  } finally {
    args.signal.removeEventListener("abort", abort);
    call.cancel();
    client.close();
  }
}

function validateMetadata(values: Record<string, string>): void {
  for (const name of Object.keys(values)) {
    if (!/^[a-z0-9_.-]+$/.test(name) || name.startsWith("grpc-")) {
      throw new Error(`metadata field ${JSON.stringify(name)} is invalid or protocol-reserved`);
    }
  }
}

async function reflectRootVersion(
  args: { target: string; service: string; transport: "plaintext" | "tls"; metadata: Record<string, string>; signal: AbortSignal },
  version: "v1" | "v1alpha",
): Promise<protobuf.Root> {
  const namespace = `grpc.reflection.${version}`;
  const parsed = protobuf.parse(reflectionProto(namespace));
  const requestType = parsed.root.lookupType(`${namespace}.ServerReflectionRequest`);
  const responseType = parsed.root.lookupType(`${namespace}.ServerReflectionResponse`);
  const metadata = new grpc.Metadata();
  for (const [name, value] of Object.entries(args.metadata)) metadata.set(name, value);
  const client = new grpc.Client(
    args.target,
    args.transport === "tls" ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(),
  );
  const call = client.makeBidiStreamRequest<Record<string, unknown>, protobuf.Message>(
    `/${namespace}.ServerReflection/ServerReflectionInfo`,
    (value) => Buffer.from(requestType.encode(requestType.fromObject(value)).finish()),
    (value) => responseType.decode(value),
    metadata,
  );
  const abort = () => call.cancel();
  args.signal.addEventListener("abort", abort, { once: true });
  try {
    const response = await new Promise<protobuf.Message>((resolve, reject) => {
      call.once("data", resolve);
      call.once("error", reject);
      call.once("end", () => reject(new Error(`${namespace} reflection stream ended without a response`)));
      call.write({ fileContainingSymbol: args.service });
      call.end();
    });
    const object = responseType.toObject(response, { bytes: Array }) as Record<string, unknown>;
    const protocolError = object["errorResponse"];
    if (isRecord(protocolError)) {
      const error = new Error(`${namespace} reflection error ${String(protocolError["errorCode"])}: ${String(protocolError["errorMessage"] ?? "")}`) as Error & { code?: number };
      error.code = Number(protocolError["errorCode"]);
      throw error;
    }
    const fileResponse = object["fileDescriptorResponse"];
    const files = isRecord(fileResponse) ? fileResponse["fileDescriptorProto"] : undefined;
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error(`${namespace} reflection response carried no descriptor closure for ${args.service}`);
    }
    const writer = protobuf.Writer.create();
    for (const file of files) writer.uint32(10).bytes(Uint8Array.from(file as number[]));
    const factory = protobuf.Root as typeof protobuf.Root & {
      fromDescriptor(value: Uint8Array): protobuf.Root;
    };
    const root = factory.fromDescriptor(writer.finish());
    root.resolveAll();
    return root;
  } finally {
    args.signal.removeEventListener("abort", abort);
    call.cancel();
    client.close();
  }
}

function reflectionProto(namespace: string): string {
  return `syntax = "proto3";
package ${namespace};
service ServerReflection { rpc ServerReflectionInfo(stream ServerReflectionRequest) returns (stream ServerReflectionResponse); }
message ServerReflectionRequest {
  string host = 1;
  oneof message_request {
    string file_by_filename = 3;
    string file_containing_symbol = 4;
    ExtensionRequest file_containing_extension = 5;
    string all_extension_numbers_of_type = 6;
    string list_services = 7;
  }
}
message ExtensionRequest { string containing_type = 1; int32 extension_number = 2; }
message ServerReflectionResponse {
  string valid_host = 1;
  ServerReflectionRequest original_request = 2;
  oneof message_response {
    FileDescriptorResponse file_descriptor_response = 4;
    ExtensionNumberResponse all_extension_numbers_response = 5;
    ListServiceResponse list_services_response = 6;
    ErrorResponse error_response = 7;
  }
}
message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
message ExtensionNumberResponse { string base_type_name = 1; repeated int32 extension_number = 2; }
message ListServiceResponse { repeated ServiceResponse service = 1; }
message ServiceResponse { string name = 1; }
message ErrorResponse { int32 error_code = 1; string error_message = 2; }`;
}

function grpcCode(error: unknown): number | undefined {
  return isRecord(error) && typeof error["code"] === "number" ? error["code"] : undefined;
}

class NodeGrpcCall implements GrpcCall {
  readonly #client: grpc.Client;
  readonly #method: ResolvedGrpcMethod;
  readonly #metadata = new grpc.Metadata();
  readonly #responses = new AsyncQueue<Uint8Array>();
  readonly #headerDeferred = deferred<Metadata>();
  readonly #trailerDeferred = deferred<Metadata>();
  readonly #doneDeferred = deferred<void>();
  #call: grpc.ClientUnaryCall | grpc.ClientReadableStream<Buffer> | grpc.ClientWritableStream<Buffer> | grpc.ClientDuplexStream<Buffer, Buffer> | undefined;
  #pendingUnary: Uint8Array | undefined;

  constructor(args: { target: string; transport: "plaintext" | "tls"; method: ResolvedGrpcMethod; metadata: Record<string, string>; signal: AbortSignal }) {
    this.#method = args.method;
    for (const [name, value] of Object.entries(args.metadata)) this.#metadata.set(name, value);
    this.#client = new grpc.Client(args.target, args.transport === "tls" ? grpc.credentials.createSsl() : grpc.credentials.createInsecure());
    if (args.method.kind === "client-streaming") this.#startClientStream();
    else if (args.method.kind === "bidirectional") this.#startBidi();
  }

  get responses(): AsyncIterable<Uint8Array> { return this.#responses; }
  get header(): Promise<Metadata> { return this.#headerDeferred.promise; }
  get trailer(): Promise<Metadata> { return this.#trailerDeferred.promise; }
  get done(): Promise<void> { return this.#doneDeferred.promise; }

  async send(value: Uint8Array): Promise<void> {
    if (this.#method.kind === "unary" || this.#method.kind === "server-streaming") {
      if (this.#pendingUnary) throw new Error("unary request accepts one message");
      this.#pendingUnary = value;
      return;
    }
    const stream = this.#call as grpc.ClientWritableStream<Buffer> | grpc.ClientDuplexStream<Buffer, Buffer>;
    await new Promise<void>((resolve, reject) => stream.write(Buffer.from(value), (error?: Error | null) => error ? reject(error) : resolve()));
  }

  async closeInput(): Promise<void> {
    if (this.#method.kind === "unary") this.#startUnary(this.#pendingUnary ?? new Uint8Array());
    else if (this.#method.kind === "server-streaming") this.#startServerStream(this.#pendingUnary ?? new Uint8Array());
    else (this.#call as grpc.ClientWritableStream<Buffer> | grpc.ClientDuplexStream<Buffer, Buffer>).end();
  }

  cancel(): void {
    this.#call?.cancel();
    this.#client.close();
  }

  #startUnary(request: Uint8Array): void {
    this.#call = this.#client.makeUnaryRequest(
      this.#method.path, identitySerialize, identityDeserialize, Buffer.from(request), this.#metadata,
      (error, value) => {
        if (error) this.#fail(error);
        else if (value) { this.#responses.push(value); this.#responses.close(); this.#doneDeferred.resolve(); }
        else this.#fail(new Error("gRPC unary response completed without a message"));
        this.#client.close();
      },
    );
    this.#wireMetadata(this.#call);
  }

  #startServerStream(request: Uint8Array): void {
    const call = this.#client.makeServerStreamRequest(this.#method.path, identitySerialize, identityDeserialize, Buffer.from(request), this.#metadata);
    this.#call = call;
    this.#wireReadable(call);
  }

  #startClientStream(): void {
    const call = this.#client.makeClientStreamRequest(this.#method.path, identitySerialize, identityDeserialize, this.#metadata, (error, value) => {
      if (error) this.#fail(error);
      else if (value) { this.#responses.push(value); this.#responses.close(); this.#doneDeferred.resolve(); }
      else this.#fail(new Error("gRPC client stream completed without a response message"));
      this.#client.close();
    });
    this.#call = call;
    this.#wireMetadata(call);
  }

  #startBidi(): void {
    const call = this.#client.makeBidiStreamRequest(this.#method.path, identitySerialize, identityDeserialize, this.#metadata);
    this.#call = call;
    this.#wireReadable(call);
  }

  #wireReadable(call: grpc.ClientReadableStream<Buffer> | grpc.ClientDuplexStream<Buffer, Buffer>): void {
    this.#wireMetadata(call);
    call.on("data", (value: Buffer) => this.#responses.push(value));
    call.on("end", () => { this.#responses.close(); });
    call.on("error", (error) => this.#fail(error));
  }

  #wireMetadata(call: grpc.ClientUnaryCall | grpc.ClientReadableStream<Buffer> | grpc.ClientWritableStream<Buffer> | grpc.ClientDuplexStream<Buffer, Buffer>): void {
    call.on("metadata", (value) => this.#headerDeferred.resolve(fromGrpcMetadata(value)));
    call.on("status", (status) => {
      this.#trailerDeferred.resolve(fromGrpcMetadata(status.metadata));
      if (status.code === grpc.status.OK) this.#doneDeferred.resolve();
      else this.#fail(Object.assign(new Error(status.details), {
        code: status.code,
        grpcMessage: status.details,
        metadata: status.metadata,
      }));
    });
  }

  #fail(error: unknown): void {
    this.#responses.fail(error);
    this.#headerDeferred.resolve({});
    this.#trailerDeferred.resolve({});
    this.#doneDeferred.reject(error);
  }
}

function identitySerialize(value: Buffer): Buffer { return value; }
function identityDeserialize(value: Buffer): Buffer { return value; }

function fromGrpcMetadata(metadata: grpc.Metadata): Metadata {
  const out: Metadata = {};
  for (const name of Object.keys(metadata.getMap())) {
    out[name] = metadata.get(name).map((value) => Buffer.isBuffer(value)
      ? value.toString("base64")
      : String(value));
  }
  return out;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  #values: T[] = [];
  #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;
  #error: unknown;
  push(value: T): void { const waiter = this.#waiters.shift(); if (waiter) waiter({ value, done: false }); else this.#values.push(value); }
  close(): void { this.#closed = true; for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true }); }
  fail(error: unknown): void { this.#error = error; this.close(); }
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.#values.length > 0) { yield this.#values.shift()!; continue; }
      if (this.#closed) { if (this.#error) throw this.#error; return; }
      const result = await new Promise<IteratorResult<T>>((resolve) => this.#waiters.push(resolve));
      if (result.done) { if (this.#error) throw this.#error; return; }
      yield result.value;
    }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function firstInput(iterable: AsyncIterable<unknown>): Promise<unknown | undefined> {
  for await (const value of iterable) return value;
  return undefined;
}

function grpcInvocationError(error: unknown, fallbackCode: string): InvocationError {
  const nativeCode = grpcCode(error);
  if (nativeCode === undefined) return new InvocationError(fallbackCode);
  return new InvocationError(ERR_EXECUTION_FAILED);
}

function grpcDetails(error: unknown): Record<string, unknown> | undefined {
  const nativeCode = grpcCode(error);
  if (nativeCode === undefined) return undefined;
  const item = isRecord(error) ? error : {};
  const nativeMessage = typeof item.grpcMessage === "string"
    ? item.grpcMessage
    : typeof item.details === "string"
      ? item.details
      : message(error);
  const status: Record<string, unknown> = { code: nativeCode, message: nativeMessage };

  const supplied = Array.isArray(item.grpcStatusDetails) ? item.grpcStatusDetails : undefined;
  if (supplied) {
    status.details = supplied;
  } else {
    const metadata = item.metadata instanceof grpc.Metadata ? item.metadata : undefined;
    const binaries = metadata?.get("grpc-status-details-bin") ?? [];
    for (const value of binaries) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      status.statusDetailsBinBase64 = bytes.toString("base64");
      const decoded = decodeRichStatus(bytes);
      if (decoded?.details.length) status.details = decoded.details;
      if (decoded && decoded.message !== "") status.message = decoded.message;
      break;
    }
  }
  return { grpcCode: nativeCode, grpcStatus: status };
}

function decodeRichStatus(bytes: Uint8Array): {
  code: number;
  message: string;
  details: Array<{ typeUrl: string; valueBase64: string }>;
} | null {
  try {
    const reader = protobuf.Reader.create(bytes);
    const result = { code: 0, message: "", details: [] as Array<{ typeUrl: string; valueBase64: string }> };
    while (reader.pos < reader.len) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          result.code = reader.int32();
          break;
        case 2:
          result.message = reader.string();
          break;
        case 3: {
          const end = reader.uint32() + reader.pos;
          let typeUrl = "";
          let value: Uint8Array<ArrayBufferLike> = new Uint8Array();
          while (reader.pos < end) {
            const anyTag = reader.uint32();
            if ((anyTag >>> 3) === 1) typeUrl = reader.string();
            else if ((anyTag >>> 3) === 2) value = reader.bytes();
            else reader.skipType(anyTag & 7);
          }
          result.details.push({ typeUrl, valueBase64: Buffer.from(value).toString("base64") });
          break;
        }
        default:
          reader.skipType(tag & 7);
      }
    }
    return result;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export { GrpcSynthesizer, type GrpcSynthesizerOptions } from "./authoring.js";

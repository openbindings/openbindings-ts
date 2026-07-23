import * as protobuf from "protobufjs";
import {
  MAX_TESTED_VERSION,
  MultipleSourcesError,
  finalizeSynthesis,
  synthesisSkeleton,
  type BindingSpecInfo,
  type InterfaceSynthesizer,
  type JSONSchema,
  type OBInterface,
  type Operation,
  type Source,
  type SourceInspection,
  type SourceInspector,
  type SynthesizeInput,
  type SynthesizerWarning,
} from "@openbindings/sdk";
import {
  BINDING_SPEC,
  discoverReflectedSchema,
  loadProtobufSchema,
} from "./index.js";

export interface GrpcSynthesizerOptions {
  /** Transport election for a bare host:port reflection address. */
  transport?: "plaintext" | "tls";
  /** Explicit outgoing reflection metadata; generic credentials have no carriage here. */
  metadata?: Record<string, string>;
}

type ProtoSource = Pick<Source, "bindingSpec" | "location" | "content">;

/** Authoring implementation for protobuf-backed gRPC sources. */
export class GrpcSynthesizer implements InterfaceSynthesizer, SourceInspector {
  readonly #transport?: "plaintext" | "tls";
  readonly #metadata: Record<string, string>;

  constructor(options: GrpcSynthesizerOptions = {}) {
    this.#transport = options.transport;
    this.#metadata = { ...(options.metadata ?? {}) };
  }

  bindingSpecs(): BindingSpecInfo[] {
    return [{ bindingSpec: BINDING_SPEC, description: "gRPC via protobuf schemas or server reflection" }];
  }

  async synthesizeInterface(input: SynthesizeInput, options?: { signal?: AbortSignal }): Promise<OBInterface> {
    const sources = input.sources ?? [];
    if (sources.length === 0) return synthesisSkeleton(input);
    if (sources.length > 1) throw new MultipleSourcesError();
    const source = sources[0]!;
    if (source.bindingSpec !== BINDING_SPEC) throw new Error(`synthesizer supports exact binding specification ${JSON.stringify(BINDING_SPEC)}, got ${JSON.stringify(source.bindingSpec)}`);
    if (source.outputLocation) validateDialLocation(source.outputLocation);
    if (source.embed && source.content === undefined) {
      throw new Error("gRPC reflection embedding is not supported: preserving the complete reflected descriptor closure is required; provide embedded protobuf content explicitly");
    }
    const root = await this.#load(source, options?.signal);
    const iface = protobufInterface(root, source, true, input.onWarning);
    return finalizeSynthesis(iface, input, "default", BINDING_SPEC);
  }

  async inspectSource(source: Source, options?: { signal?: AbortSignal }): Promise<SourceInspection> {
    const root = await this.#load(source, options?.signal);
    return inspectProtobuf(root, true);
  }

  async #load(source: ProtoSource, signal?: AbortSignal): Promise<protobuf.Root> {
    if (!source.location) throw new Error("gRPC source requires a dial location");
    if (source.content !== undefined) return loadProtobufSchema(source.content);
    return discoverReflectedSchema(source.location, {
      transport: this.#transport,
      metadata: this.#metadata,
      signal,
    });
  }
}

function validateDialLocation(location: string): void {
  let address = location;
  if (address.startsWith("grpc://")) address = address.slice("grpc://".length);
  else if (address.startsWith("grpcs://")) address = address.slice("grpcs://".length);
  else if (address.includes("://")) throw new Error(`gRPC outputLocation ${JSON.stringify(location)} uses an undefined scheme`);
  if (!/^(?:\[[^\]]+\]|[^/:\s]+):\d+$/.test(address)) {
    throw new Error(`gRPC outputLocation ${JSON.stringify(location)} must be host:port with an explicit port`);
  }
}

export function protobufInterface(
  root: protobuf.Root,
  source: ProtoSource,
  includeClientStreaming: boolean,
  onWarning?: (warning: SynthesizerWarning) => void,
): OBInterface {
  const services = collectServices(root);
  const sourceEntry: Source = { bindingSpec: BINDING_SPEC };
  if (source.location) sourceEntry.location = source.location;
  if (source.content !== undefined) sourceEntry.content = source.content;
  const iface: OBInterface = {
    openbindings: MAX_TESTED_VERSION,
    operations: {},
    bindings: {},
    sources: { default: sourceEntry },
  };
  const used = new Map<string, string>();
  for (const service of services) {
    for (const method of Object.values(service.methods).sort((a, b) => codePointCompare(a.name, b.name))) {
      if (!includeClientStreaming && method.requestStream) continue;
      const ref = `${qualifiedName(service)}/${method.name}`;
      const operationKey = resolveKey(sanitizeKey(method.name), service.name, used);
      used.set(operationKey, ref);
      const operation: Operation = {};
      if (method.comment) operation.description = method.comment.trim();
      const requestType = root.lookupType(method.requestType);
      const responseType = root.lookupType(method.responseType);
      operation.input = new SchemaWalker(onWarning, `operations.${operationKey}.input`).message(requestType);
      operation.output = new SchemaWalker(onWarning, `operations.${operationKey}.output`).message(responseType);
      iface.operations[operationKey] = operation;
      iface.bindings![`${operationKey}.default`] = { operation: operationKey, source: "default", ref };
    }
  }
  if (services.length === 1) iface.name = services[0]!.name;
  else if (services.length > 1) iface.name = packageName(services[0]!);
  return iface;
}

export function inspectProtobuf(root: protobuf.Root, includeClientStreaming: boolean): SourceInspection {
  const targets: SourceInspection["targets"] = [];
  const used = new Map<string, string>();
  for (const service of collectServices(root)) {
    for (const method of Object.values(service.methods).sort((a, b) => codePointCompare(a.name, b.name))) {
      if (!includeClientStreaming && method.requestStream) continue;
      const ref = `${qualifiedName(service)}/${method.name}`;
      const operationKey = resolveKey(sanitizeKey(method.name), service.name, used);
      used.set(operationKey, ref);
      const description = method.comment?.trim();
      targets.push({ ref, operationKey, operation: description ? { description } : undefined });
    }
  }
  return { targets, exhaustive: true };
}

function collectServices(root: protobuf.Root): protobuf.Service[] {
  const services: protobuf.Service[] = [];
  const walk = (namespace: protobuf.NamespaceBase): void => {
    for (const nested of namespace.nestedArray) {
      if (nested instanceof protobuf.Service && !qualifiedName(nested).startsWith("grpc.reflection.")) services.push(nested);
      if (nested instanceof protobuf.Namespace) walk(nested);
    }
  };
  walk(root);
  return services.sort((a, b) => codePointCompare(qualifiedName(a), qualifiedName(b)));
}

function qualifiedName(value: protobuf.ReflectionObject): string {
  return value.fullName.replace(/^\./, "");
}

function packageName(service: protobuf.Service): string {
  const full = qualifiedName(service);
  return full.includes(".") ? full.slice(0, full.lastIndexOf(".")) : service.name;
}

class SchemaWalker {
  readonly #visited = new Set<string>();
  readonly #onWarning: ((warning: SynthesizerWarning) => void) | undefined;
  readonly #path: string;
  constructor(
    onWarning: ((warning: SynthesizerWarning) => void) | undefined,
    path: string,
  ) {
    this.#onWarning = onWarning;
    this.#path = path;
  }

  message(type: protobuf.Type): JSONSchema {
    const fqn = qualifiedName(type);
    const wellKnown = wellKnownSchema(fqn);
    if (wellKnown) return wellKnown;
    if (this.#visited.has(fqn)) return { type: "object" };
    this.#visited.add(fqn);
    try {
      const fields = Object.values(type.fields).sort((a, b) => a.id - b.id);
      const groups = new Map<string, protobuf.Field[]>();
      const regular: protobuf.Field[] = [];
      for (const field of fields) {
        const group = field.partOf?.name;
        if (!group) regular.push(field);
        else groups.set(group, [...(groups.get(group) ?? []), field]);
      }
      const schema: Record<string, unknown> = { type: "object" };
      const properties: Record<string, JSONSchema> = {};
      const useOneOf = groups.size === 1;
      if (groups.size > 1) {
        this.#onWarning?.({
          code: `${BINDING_SPEC === "openbindings.grpc@1" ? "grpc" : "connect"}.multi_group_oneof`,
          message: `message ${type.name} contains ${groups.size} oneof groups; the v0.2 schema profile cannot express independent group exclusivity, so members are emitted as optional properties`,
          path: this.#path,
        });
      }
      for (const field of regular) properties[jsonName(field)] = this.field(field);
      if (!useOneOf) for (const group of groups.values()) for (const field of group) properties[jsonName(field)] = this.field(field);
      if (Object.keys(properties).length > 0) schema.properties = properties;
      if (useOneOf) {
        const group = [...groups.values()][0]!;
        schema.oneOf = group.map((field) => ({
          type: "object",
          properties: { [jsonName(field)]: this.field(field) },
          required: [jsonName(field)],
        }));
      }
      return schema;
    } finally {
      this.#visited.delete(fqn);
    }
  }

  field(field: protobuf.Field): JSONSchema {
    const value = this.scalarOrMessage(field);
    if (field.map) return { type: "object", additionalProperties: value };
    if (field.repeated) return { type: "array", items: value };
    return value;
  }

  scalarOrMessage(field: protobuf.Field): JSONSchema {
    if (field.resolvedType instanceof protobuf.Type) return this.message(field.resolvedType);
    if (field.resolvedType instanceof protobuf.Enum) {
      return { type: "string", enum: Object.keys(field.resolvedType.values) };
    }
    switch (field.type) {
      case "bool": return { type: "boolean" };
      case "int32": case "sint32": case "sfixed32": case "uint32": case "fixed32": return { type: "integer" };
      case "int64": case "sint64": case "sfixed64": case "uint64": case "fixed64": return { type: "integer", format: "int64" };
      case "float": case "double": return { type: "number" };
      case "string": case "bytes": return { type: "string" };
      default: return { type: "string" };
    }
  }
}

function wellKnownSchema(fqn: string): JSONSchema | undefined {
  switch (fqn) {
    case "google.protobuf.Timestamp": return { type: "string", format: "date-time" };
    case "google.protobuf.Duration": return { type: "string", description: "Duration in seconds with up to nine fractional digits, suffixed with 's'" };
    case "google.protobuf.FieldMask": return { type: "string", description: "Comma-separated list of fully-qualified field paths" };
    case "google.protobuf.Struct": case "google.protobuf.Empty": return { type: "object" };
    case "google.protobuf.Value": return {};
    case "google.protobuf.ListValue": return { type: "array" };
    case "google.protobuf.BoolValue": return { type: "boolean" };
    case "google.protobuf.StringValue": case "google.protobuf.BytesValue": return { type: "string" };
    case "google.protobuf.Int32Value": case "google.protobuf.UInt32Value": return { type: "integer" };
    case "google.protobuf.Int64Value": case "google.protobuf.UInt64Value": return { type: "integer", format: "int64" };
    case "google.protobuf.FloatValue": case "google.protobuf.DoubleValue": return { type: "number" };
    case "google.protobuf.Any": return { type: "object", properties: { "@type": { type: "string" }, value: {} }, required: ["@type"] };
    default: return undefined;
  }
}

function jsonName(field: protobuf.Field): string {
  const configured = field.options?.["json_name"];
  return typeof configured === "string" ? configured : field.name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function sanitizeKey(name: string): string {
  const key = name.replace(/[^a-zA-Z0-9._-]/gu, "_").replace(/^_+|_+$/g, "");
  if (!key) return "unnamed";
  return /^[A-Za-z_]/.test(key) ? key : `_${key}`;
}

function resolveKey(key: string, entity: string, used: Map<string, string>): string {
  if (!used.has(key)) return key;
  const prefixed = `${sanitizeKey(entity)}_${key}`;
  if (!used.has(prefixed)) return prefixed;
  for (let index = 2; ; index++) {
    const candidate = `${prefixed}_${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

function codePointCompare(a: string, b: string): number {
  const ac = [...a];
  const bc = [...b];
  for (let index = 0; index < Math.min(ac.length, bc.length); index++) {
    const delta = ac[index]!.codePointAt(0)! - bc[index]!.codePointAt(0)!;
    if (delta !== 0) return delta;
  }
  return ac.length - bc.length;
}

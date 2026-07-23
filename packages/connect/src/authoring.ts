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
import { BINDING_SPEC, loadProtobufSchema } from "./index.js";

type ProtoSource = Pick<Source, "bindingSpec" | "location" | "content">;

/** Authoring implementation for schema-mode Connect sources. */
export class ConnectSynthesizer implements InterfaceSynthesizer, SourceInspector {
  bindingSpecs(): BindingSpecInfo[] {
    return [{ bindingSpec: BINDING_SPEC, description: "Connect via embedded protobuf schemas" }];
  }

  async synthesizeInterface(input: SynthesizeInput): Promise<OBInterface> {
    const sources = input.sources ?? [];
    if (sources.length === 0) return synthesisSkeleton(input);
    if (sources.length > 1) throw new MultipleSourcesError();
    const source = sources[0]!;
    if (source.bindingSpec !== BINDING_SPEC) throw new Error(`synthesizer supports exact binding specification ${JSON.stringify(BINDING_SPEC)}, got ${JSON.stringify(source.bindingSpec)}`);
    if (source.outputLocation) {
      const url = new URL(source.outputLocation);
      if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.host) {
        throw new Error("Connect outputLocation must be an absolute HTTP(S) service URL");
      }
    }
    const root = loadSchema(source);
    const iface = protobufInterface(root, source, input.onWarning);
    return finalizeSynthesis(iface, input, "default", BINDING_SPEC);
  }

  async inspectSource(source: Source): Promise<SourceInspection> {
    return inspectProtobuf(loadSchema(source));
  }
}

function loadSchema(source: ProtoSource): protobuf.Root {
  if (!source.location) throw new Error("Connect source requires an HTTP(S) base URL");
  const url = new URL(source.location);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Connect source location must use http or https");
  if (source.content === undefined) {
    throw new Error("descriptorless Connect sources expose no discoverable operation set; synthesis requires embedded protobuf content");
  }
  return loadProtobufSchema(source.content);
}

function protobufInterface(
  root: protobuf.Root,
  source: ProtoSource,
  onWarning?: (warning: SynthesizerWarning) => void,
): OBInterface {
  const services = collectServices(root);
  const sourceEntry: Source = { bindingSpec: BINDING_SPEC, location: source.location, content: source.content };
  const iface: OBInterface = {
    openbindings: MAX_TESTED_VERSION,
    operations: {},
    bindings: {},
    sources: { default: sourceEntry },
  };
  const used = new Map<string, string>();
  for (const service of services) {
    for (const method of Object.values(service.methods).sort((a, b) => compare(a.name, b.name))) {
      const ref = `${qualifiedName(service)}/${method.name}`;
      const operationKey = resolveKey(sanitizeKey(method.name), service.name, used);
      used.set(operationKey, ref);
      const operation: Operation = iface.operations[operationKey] = {
        input: new SchemaWalker(onWarning, `operations.${operationKey}.input`).message(root.lookupType(method.requestType)),
        output: new SchemaWalker(onWarning, `operations.${operationKey}.output`).message(root.lookupType(method.responseType)),
      };
      if (method.comment) operation.description = method.comment.trim();
      iface.bindings![`${operationKey}.default`] = { operation: operationKey, source: "default", ref };
    }
  }
  if (services.length === 1) iface.name = services[0]!.name;
  else if (services.length > 1) iface.name = packageName(services[0]!);
  return iface;
}

function inspectProtobuf(root: protobuf.Root): SourceInspection {
  const targets: SourceInspection["targets"] = [];
  const used = new Map<string, string>();
  for (const service of collectServices(root)) {
    for (const method of Object.values(service.methods).sort((a, b) => compare(a.name, b.name))) {
      const ref = `${qualifiedName(service)}/${method.name}`;
      const operationKey = resolveKey(sanitizeKey(method.name), service.name, used);
      used.set(operationKey, ref);
      const description = method.comment?.trim();
      targets.push({ ref, operationKey, operation: description ? { description } : undefined });
    }
  }
  return { targets, exhaustive: true };
}

class SchemaWalker {
  readonly #visited = new Set<string>();
  constructor(
    readonly onWarning: ((warning: SynthesizerWarning) => void) | undefined,
    readonly path: string,
  ) {}

  message(type: protobuf.Type): JSONSchema {
    const fqn = qualifiedName(type);
    const wk = wellKnownSchema(fqn);
    if (wk) return wk;
    if (this.#visited.has(fqn)) return { type: "object" };
    this.#visited.add(fqn);
    try {
      const fields = Object.values(type.fields).sort((a, b) => a.id - b.id);
      const groups = new Map<string, protobuf.Field[]>();
      const regular: protobuf.Field[] = [];
      for (const field of fields) {
        if (field.partOf) groups.set(field.partOf.name, [...(groups.get(field.partOf.name) ?? []), field]);
        else regular.push(field);
      }
      const schema: Record<string, unknown> = { type: "object" };
      const properties: Record<string, JSONSchema> = {};
      const oneGroup = groups.size === 1;
      if (groups.size > 1) this.onWarning?.({
        code: "connect.multi_group_oneof",
        message: `message ${type.name} contains ${groups.size} oneof groups; the v0.2 schema profile cannot express independent group exclusivity, so members are emitted as optional properties`,
        path: this.path,
      });
      for (const field of regular) properties[jsonName(field)] = this.field(field);
      if (!oneGroup) for (const group of groups.values()) for (const field of group) properties[jsonName(field)] = this.field(field);
      if (Object.keys(properties).length > 0) schema.properties = properties;
      if (oneGroup) schema.oneOf = [...groups.values()][0]!.map((field) => ({
        type: "object", properties: { [jsonName(field)]: this.field(field) }, required: [jsonName(field)],
      }));
      return schema;
    } finally {
      this.#visited.delete(fqn);
    }
  }

  field(field: protobuf.Field): JSONSchema {
    const value = this.scalar(field);
    if (field.map) return { type: "object", additionalProperties: value };
    if (field.repeated) return { type: "array", items: value };
    return value;
  }

  scalar(field: protobuf.Field): JSONSchema {
    if (field.resolvedType instanceof protobuf.Type) return this.message(field.resolvedType);
    if (field.resolvedType instanceof protobuf.Enum) return { type: "string", enum: Object.keys(field.resolvedType.values) };
    switch (field.type) {
      case "bool": return { type: "boolean" };
      case "int32": case "sint32": case "sfixed32": case "uint32": case "fixed32": return { type: "integer" };
      case "int64": case "sint64": case "sfixed64": case "uint64": case "fixed64": return { type: "integer", format: "int64" };
      case "float": case "double": return { type: "number" };
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

function collectServices(root: protobuf.Root): protobuf.Service[] {
  const output: protobuf.Service[] = [];
  const walk = (namespace: protobuf.NamespaceBase): void => {
    for (const nested of namespace.nestedArray) {
      if (nested instanceof protobuf.Service) output.push(nested);
      if (nested instanceof protobuf.Namespace) walk(nested);
    }
  };
  walk(root);
  return output.sort((a, b) => compare(qualifiedName(a), qualifiedName(b)));
}

function qualifiedName(value: protobuf.ReflectionObject): string { return value.fullName.replace(/^\./, ""); }
function packageName(service: protobuf.Service): string { const fqn = qualifiedName(service); return fqn.includes(".") ? fqn.slice(0, fqn.lastIndexOf(".")) : service.name; }
function jsonName(field: protobuf.Field): string { const name = field.options?.["json_name"]; return typeof name === "string" ? name : field.name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()); }
function sanitizeKey(name: string): string { const key = name.replace(/[^a-zA-Z0-9._-]/gu, "_").replace(/^_+|_+$/g, ""); return key ? /^[A-Za-z_]/.test(key) ? key : `_${key}` : "unnamed"; }
function resolveKey(key: string, entity: string, used: Map<string, string>): string { if (!used.has(key)) return key; const base = `${sanitizeKey(entity)}_${key}`; if (!used.has(base)) return base; for (let i = 2; ; i++) if (!used.has(`${base}_${i}`)) return `${base}_${i}`; }
function compare(a: string, b: string): number { const aa = [...a], bb = [...b]; for (let i = 0; i < Math.min(aa.length, bb.length); i++) { const d = aa[i]!.codePointAt(0)! - bb[i]!.codePointAt(0)!; if (d) return d; } return aa.length - bb.length; }

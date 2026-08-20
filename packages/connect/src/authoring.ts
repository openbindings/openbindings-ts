import * as protobuf from "protobufjs";
import {
  MAX_TESTED_VERSION,
  type BindingSpecInfo,
  type JSONSchema,
  type OBInterface,
  type Operation,
  type Source,
} from "@openbindings/core";
import {
  MultipleSourcesError,
  finalizeSynthesis,
  finalizeSynthesisCoverage,
  synthesisSkeleton,
  type CoverageSynthesizer,
  type InterfaceSynthesizer,
  type SourceInspection,
  type SourceInspector,
  type SynthesizeInput,
  type SynthesizeResult,
  type SynthesizerWarning,
} from "@openbindings/synthesize";
import { BINDING_SPEC, loadProtobufSchema } from "./index.js";
import { protobufSynthesisCoverage } from "./coverage.js";
import { boundMethodRangeError } from "./schema-range.js";

type ProtoSource = Pick<Source, "bindingSpec" | "location" | "content">;

/** Authoring implementation for schema-mode Connect sources. */
export class ConnectSynthesizer implements InterfaceSynthesizer, CoverageSynthesizer, SourceInspector {
  bindingSpecs(): BindingSpecInfo[] {
    return [{ bindingSpec: BINDING_SPEC, description: "Connect via embedded protobuf schemas" }];
  }

  async synthesizeInterface(input: SynthesizeInput): Promise<OBInterface> {
    return (await this.#synthesizeObserved(input)).iface;
  }

  async synthesizeInterfaceWithCoverage(input: SynthesizeInput): Promise<SynthesizeResult> {
    const observation = await this.#synthesizeObserved(input);
    return finalizeSynthesisCoverage(
      observation.iface,
      protobufSynthesisCoverage(observation.root, observation.iface, observation.warnings),
      true,
    );
  }

  async #synthesizeObserved(
    input: SynthesizeInput,
  ): Promise<{ iface: OBInterface; root?: protobuf.Root; warnings: SynthesizerWarning[] }> {
    const sources = input.sources ?? [];
    if (sources.length === 0) return { iface: synthesisSkeleton(input), warnings: [] };
    if (sources.length > 1) throw new MultipleSourcesError();
    const source = sources[0]!;
    if (source.bindingSpec !== BINDING_SPEC) throw new Error(`synthesizer supports exact binding specification ${JSON.stringify(BINDING_SPEC)}, got ${JSON.stringify(source.bindingSpec)}`);
    if (source.outputLocation) validateBaseURL(source.outputLocation);
    const root = loadSchema(source);
    const warnings: SynthesizerWarning[] = [];
    const observeWarning = (warning: SynthesizerWarning): void => {
      warnings.push(warning);
      input.onWarning?.(warning);
    };
    const iface = finalizeSynthesis(
      protobufInterface(root, source, observeWarning),
      input,
      "default",
      BINDING_SPEC,
    );
    return { iface, root, warnings };
  }

  async inspectSource(source: Source): Promise<SourceInspection> {
    return inspectProtobuf(loadSchema(source));
  }
}

function loadSchema(source: ProtoSource): protobuf.Root {
  if (!source.location) throw new Error("Connect source requires an HTTP(S) base URL");
  validateBaseURL(source.location);
  if (source.content === undefined) {
    throw new Error("descriptorless Connect sources expose no discoverable operation set; synthesis requires embedded protobuf content");
  }
  return loadProtobufSchema(source.content);
}

function validateBaseURL(location: string): void {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new Error(`Connect base URL ${JSON.stringify(location)} must be an absolute HTTP(S) URI`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.host) {
    throw new Error(`Connect base URL ${JSON.stringify(location)} must be an absolute HTTP(S) URI`);
  }
  if (url.username || url.password) {
    throw new Error(`Connect base URL ${JSON.stringify(location)} must not carry userinfo`);
  }
  if (url.search) {
    throw new Error(`Connect base URL ${JSON.stringify(location)} must not carry a query`);
  }
  if (url.hash) {
    throw new Error(`Connect base URL ${JSON.stringify(location)} must not carry a fragment`);
  }
  if (location.endsWith("/")) {
    throw new Error(`Connect base URL ${JSON.stringify(location)} must not carry a trailing slash`);
  }
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
      if (boundMethodRangeError(root, method)) continue;
      const ref = `${qualifiedName(service)}/${method.name}`;
      const operationKey = resolveKey(sanitizeKey(method.name), service.name, used);
      used.set(operationKey, ref);
      const operation: Operation = iface.operations[operationKey] = {
        input: new SchemaWalker("input", onWarning, `operations.${operationKey}.input`).root(root.lookupType(method.requestType)),
        output: new SchemaWalker("output", onWarning, `operations.${operationKey}.output`).root(root.lookupType(method.responseType)),
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
      if (boundMethodRangeError(root, method)) continue;
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
  readonly #defs: Record<string, JSONSchema> = {};
  readonly #building = new Set<string>();
  readonly #direction: "input" | "output";
  readonly #baseID: string;
  constructor(
    direction: "input" | "output",
    _onWarning: ((warning: SynthesizerWarning) => void) | undefined,
    path: string,
  ) {
    this.#direction = direction;
    this.#baseID = `urn:openbindings:generated:connect:${path}`;
  }

  root(type: protobuf.Type): JSONSchema {
    const fqn = qualifiedName(type);
    const wk = wellKnownSchema(fqn, this.#direction);
    if (wk) return wk;
    this.messageReference(type);
    return {
      ...(this.#defs[fqn] as Record<string, unknown>),
      $id: this.#baseID,
      $defs: this.#defs,
    };
  }

  messageReference(type: protobuf.Type): JSONSchema {
    const fqn = qualifiedName(type);
    const wk = wellKnownSchema(fqn, this.#direction);
    if (wk) return wk;
    if (!Object.hasOwn(this.#defs, fqn) && !this.#building.has(fqn)) {
      this.#building.add(fqn);
      this.#defs[fqn] = this.messageDefinition(type);
      this.#building.delete(fqn);
    }
    return { $ref: `${this.#baseID}#/$defs/${escapeJSONPointerToken(fqn)}` };
  }

  messageDefinition(type: protobuf.Type): JSONSchema {
    const fields = Object.values(type.fields).sort((a, b) => a.id - b.id);
    const groups = new Map<string, protobuf.Field[]>();
    const regular: protobuf.Field[] = [];
    for (const field of fields) {
      if (field.partOf) groups.set(field.partOf.name, [...(groups.get(field.partOf.name) ?? []), field]);
      else regular.push(field);
    }
    const schema: Record<string, unknown> = { type: "object", additionalProperties: false };
    const properties: Record<string, JSONSchema> = {};
    const constraints: JSONSchema[] = [];
    for (const field of regular) {
      constraints.push(...this.addProtoFieldProperties(properties, field, this.field(field)));
    }
    for (const group of groups.values()) {
      for (const field of group) {
        constraints.push(...this.addProtoFieldProperties(properties, field, this.field(field)));
      }
      constraints.push(...oneofConstraints(group, this.#direction));
    }
    if (Object.keys(properties).length > 0) schema.properties = properties;
    if (constraints.length > 0) schema.allOf = constraints;
    return schema;
  }

  addProtoFieldProperties(
    properties: Record<string, JSONSchema>,
    field: protobuf.Field,
    schema: JSONSchema,
  ): JSONSchema[] {
    const projected = this.#direction === "input"
      ? { anyOf: [schema, { type: "null" }] }
      : schema;
    const canonical = jsonName(field);
    properties[canonical] = projected;
    if (this.#direction === "input" && field.name !== canonical) {
      properties[field.name] = projected;
      return [{ not: { required: [canonical, field.name] } }];
    }
    return [];
  }

  field(field: protobuf.Field): JSONSchema {
    const value = this.scalar(field);
    if (field.map) {
      const propertyNames = protoMapKeySchema(
        field instanceof protobuf.MapField ? field.keyType : undefined,
      );
      return {
        type: "object",
        additionalProperties: value,
        ...(propertyNames ? { propertyNames } : {}),
      };
    }
    if (field.repeated) return { type: "array", items: value };
    return value;
  }

  scalar(field: protobuf.Field): JSONSchema {
    if (field.resolvedType instanceof protobuf.Type) return this.messageReference(field.resolvedType);
    if (field.resolvedType instanceof protobuf.Enum) {
      if (qualifiedName(field.resolvedType) === "google.protobuf.NullValue") return { type: "null" };
      if (this.#direction === "output") return { type: "string", enum: Object.keys(field.resolvedType.values) };
      return {
        anyOf: [
          { type: "string", enum: Object.keys(field.resolvedType.values) },
          { type: "integer", minimum: -2147483648, maximum: 2147483647 },
        ],
      };
    }
    switch (field.type) {
      case "bool": return { type: "boolean" };
      case "int32": case "sint32": case "sfixed32": return { type: "integer", minimum: -2147483648, maximum: 2147483647 };
      case "uint32": case "fixed32": return { type: "integer", minimum: 0, maximum: 4294967295 };
      case "int64": case "sint64": case "sfixed64": return integer64Schema(false, this.#direction);
      case "uint64": case "fixed64": return integer64Schema(true, this.#direction);
      case "float": case "double": return protoFloatSchema();
      case "string": return { type: "string" };
      case "bytes": return protoBytesSchema();
      default: return { type: "string" };
    }
  }
}

function wellKnownSchema(fqn: string, direction: "input" | "output" = "input"): JSONSchema | undefined {
  switch (fqn) {
    case "google.protobuf.Timestamp": return { type: "string", format: "date-time" };
    case "google.protobuf.Duration": return { type: "string", description: "Duration in seconds with up to nine fractional digits, suffixed with 's'" };
    case "google.protobuf.FieldMask": return { type: "string", description: "Comma-separated list of fully-qualified field paths" };
    case "google.protobuf.Struct": return { type: "object" };
    case "google.protobuf.Empty": return { type: "object", additionalProperties: false };
    case "google.protobuf.Value": return {};
    case "google.protobuf.ListValue": return { type: "array" };
    case "google.protobuf.BoolValue": return { type: "boolean" };
    case "google.protobuf.StringValue": return { type: "string" };
    case "google.protobuf.BytesValue": return protoBytesSchema();
    case "google.protobuf.Int32Value": return { type: "integer", minimum: -2147483648, maximum: 2147483647 };
    case "google.protobuf.UInt32Value": return { type: "integer", minimum: 0, maximum: 4294967295 };
    case "google.protobuf.Int64Value": return integer64Schema(false, direction);
    case "google.protobuf.UInt64Value": return integer64Schema(true, direction);
    case "google.protobuf.FloatValue": case "google.protobuf.DoubleValue": return protoFloatSchema();
    case "google.protobuf.Any": return { type: "object", properties: { "@type": { type: "string" }, value: {} }, required: ["@type"] };
    default: return undefined;
  }
}

function integer64Schema(unsigned: boolean, direction: "input" | "output" = "input"): JSONSchema {
  if (direction === "output") {
    return {
      type: "string",
      format: "int64",
      pattern: unsigned ? "^(?:0|[1-9][0-9]*)$" : "^-?(?:0|[1-9][0-9]*)$",
    };
  }
  return {
    anyOf: [
      {
        type: "integer",
        format: "int64",
        minimum: unsigned ? 0 : Number.MIN_SAFE_INTEGER,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      {
        type: "string",
        format: "int64",
        pattern: "^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$",
      },
    ],
  };
}

function protoMapKeySchema(keyType: string | undefined): JSONSchema | undefined {
  switch (keyType) {
    case "bool": return { enum: ["true", "false"] };
    case "int32": case "sint32": case "sfixed32":
    case "int64": case "sint64": case "sfixed64":
      return { pattern: "^-?(?:0|[1-9][0-9]*)$" };
    case "uint32": case "fixed32": case "uint64": case "fixed64":
      return { pattern: "^(?:0|[1-9][0-9]*)$" };
    default: return undefined;
  }
}

function protoBytesSchema(): JSONSchema {
  return {
    type: "string",
    pattern: "^(?:[A-Za-z0-9+/_-]{4})*(?:[A-Za-z0-9+/_-]{2}(?:==)?|[A-Za-z0-9+/_-]{3}=?)?$",
  };
}

function oneofConstraints(
  fields: protobuf.Field[],
  direction: "input" | "output",
): JSONSchema[] {
  const constraints: JSONSchema[] = [];
  for (let left = 0; left < fields.length; left++) {
    for (let right = left + 1; right < fields.length; right++) {
      for (const leftName of protoFieldSpellings(fields[left]!, direction)) {
        for (const rightName of protoFieldSpellings(fields[right]!, direction)) {
          constraints.push({
            not: {
              required: [leftName, rightName],
              properties: {
                [leftName]: { not: { type: "null" } },
                [rightName]: { not: { type: "null" } },
              },
            },
          });
        }
      }
    }
  }
  return constraints;
}

function protoFieldSpellings(field: protobuf.Field, direction: "input" | "output"): string[] {
  const canonical = jsonName(field);
  return direction === "input" && field.name !== canonical ? [canonical, field.name] : [canonical];
}

function escapeJSONPointerToken(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function protoFloatSchema(): JSONSchema {
  return {
    anyOf: [
      { type: "number" },
      { type: "string", enum: ["NaN", "Infinity", "-Infinity"] },
    ],
  };
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

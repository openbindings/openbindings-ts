import {
  MAX_TESTED_VERSION,
  type BindingEntry,
  type JSONSchema,
  type OBInterface,
  type Operation,
} from "@openbindings/core";
import {
  MultipleSourcesError,
  finalizeSynthesis,
  synthesisSkeleton,
  type SynthesizeInput,
  type SynthesisCoverageEntry,
} from "@openbindings/synthesize";
import {
  loadSwagger20,
  type Swagger20SynthesisAlternative,
  type Swagger20SynthesisDocument,
  type Swagger20SynthesisOperation,
} from "@openbindings/openapi-client/engine";
import { BINDING_SPEC_OPENAPI_20, DEFAULT_SOURCE_NAME } from "./constants.js";
import { normalizeAuthoringLocation, readAuthoringArtifact } from "./platform.js";
import { sanitizeKey, uniqueKey } from "./util.js";

interface Swagger20ProjectionLoss { sourceRef: string; reasonCode: string; message: string }

export interface Swagger20SynthesisObservation {
  iface: OBInterface;
  model?: Swagger20SynthesisDocument;
  coverage: SynthesisCoverageEntry[];
}

/** Thin OpenBindings projection over the client's detached native analysis. */
export async function synthesizeSwagger20(
  input: SynthesizeInput,
  fetchFn: typeof globalThis.fetch,
  tolerant: boolean,
  options?: { signal?: AbortSignal },
): Promise<Swagger20SynthesisObservation> {
  const sources = input.sources ?? [];
  if (sources.length === 0) return { iface: synthesisSkeleton(input), coverage: [] };
  if (sources.length > 1) throw new MultipleSourcesError();
  const source = sources[0]!;
  if (source.bindingSpec !== BINDING_SPEC_OPENAPI_20) {
    throw new Error(`ERR_UNSUPPORTED_BINDING_SPEC: binding specification ${JSON.stringify(source.bindingSpec)} is not implemented`);
  }
  const location = normalizeAuthoringLocation(source.location);
  let artifactContent = source.content;
  if (artifactContent === undefined && source.embed && location) {
    artifactContent = await readAuthoringArtifact(location, options?.signal, fetchFn);
  }
  const client = await loadSwagger20(
    { ...(location ? { location } : {}), ...(artifactContent === undefined ? {} : { content: artifactContent }) },
    { fetch: fetchFn, signal: options?.signal },
  );
  const model = await client.synthesisModel();
  const iface: OBInterface = {
    openbindings: MAX_TESTED_VERSION,
    ...(model.name ? { name: model.name } : {}),
    ...(model.version ? { version: model.version } : {}),
    ...(model.description ? { description: model.description } : {}),
    operations: {},
    bindings: {},
    sources: {
      [DEFAULT_SOURCE_NAME]: {
        bindingSpec: BINDING_SPEC_OPENAPI_20,
        ...(location ? { location } : {}),
        ...(artifactContent === undefined ? {} : { content: artifactContent }),
      },
    },
  };
  const used = new Set<string>();
  const coverage: SynthesisCoverageEntry[] = [];
  for (const operation of model.operations) {
    const operationKey = operationKeyFor(operation, used);
    if (operation.excluded) {
      if (!tolerant) throw new Error(`cannot synthesize Swagger 2.0 operation at ${JSON.stringify(operation.ref)}: ${operation.reason}`);
      coverage.push(excludedTarget(operation));
      continue;
    }
    let projected: ReturnType<typeof projectOperation>;
    try { projected = projectOperation(operation); }
    catch (error: unknown) {
      if (!tolerant) throw error;
      coverage.push({
        sourceIndex: 0, sourceRef: operation.ref, scope: "target", status: "excluded",
        reasonCode: "openapi20.schema_projection_excluded", rule: "OAPI20-P-01", message: errorMessage(error),
      });
      continue;
    }
    used.add(operationKey);
    iface.operations[operationKey] = projected.operation;
    const bindingKey = `${operationKey}.${DEFAULT_SOURCE_NAME}`;
    const binding: BindingEntry = {
      operation: operationKey, source: DEFAULT_SOURCE_NAME, selector: operation.ref,
      ...(operation.deprecated ? { deprecated: true } : {}),
      ...(projected.inputTransform ? { inputTransform: projected.inputTransform } : {}),
    };
    iface.bindings![bindingKey] = binding;
    coverage.push({
      sourceIndex: 0, sourceRef: operation.ref, scope: "target", status: "represented",
      operationKey, bindingKey, bindingSelector: operation.ref,
      requirements: sortedUnique(operation.requirements),
    });
    coverage.push(...alternativeCoverage(operation, operationKey, bindingKey));
    for (const loss of projected.losses) coverage.push({
      sourceIndex: 0, sourceRef: loss.sourceRef, scope: "projection", status: "lossy",
      operationKey, bindingKey, bindingSelector: operation.ref,
      reasonCode: loss.reasonCode, rule: "OAPI20-P-01", message: loss.message,
      requirements: [],
    });
  }
  if (Object.keys(iface.bindings ?? {}).length === 0) delete iface.bindings;
  return {
    iface: finalizeSynthesis(iface, input, DEFAULT_SOURCE_NAME, BINDING_SPEC_OPENAPI_20),
    model,
    coverage,
  };
}

function operationKeyFor(operation: Swagger20SynthesisOperation, used: Set<string>): string {
  if (operation.operationId) {
    const candidate = sanitizeKey(operation.operationId);
    if (!used.has(candidate)) return candidate;
  }
  const parts = operation.path.split("/").filter((segment) => segment !== "" && !(segment.startsWith("{") && segment.endsWith("}")));
  parts.push(operation.method.toLowerCase());
  return uniqueKey(sanitizeKey(parts.join(".")), used);
}

function projectOperation(operation: Swagger20SynthesisOperation): {
  operation: Operation;
  inputTransform?: string;
  losses: Swagger20ProjectionLoss[];
} {
  const result: Operation = {
    ...(operation.description ? { description: operation.description } : {}),
    ...(operation.deprecated ? { deprecated: true } : {}),
    ...(operation.tags.length > 0 ? { tags: [...operation.tags] } : {}),
  };
  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];
  const parameterFields: Record<string, string> = {};
  const locations = new Map<string, string>();
  let qualified = false;
  for (const parameter of operation.parameters) {
    const previous = locations.get(parameter.name);
    if (previous !== undefined && previous !== parameter.in) qualified = true;
    locations.set(parameter.name, parameter.in);
  }
  const used = new Set<string>();
  const losses: Swagger20ProjectionLoss[] = [];
  for (const parameter of operation.parameters) {
    const callerKey = qualified ? `${parameter.in}/${escapePointer(parameter.name)}` : parameter.name;
    const field = uniqueInputField(callerKey, used);
    const projected = projectSchema(parameter.schema, true, `${operation.ref}/parameters/${parameter.in}/${escapePointer(parameter.name)}`);
    properties[field] = projected.schema;
    losses.push(...projected.losses);
    parameterFields[callerKey] = field;
    if (parameter.required) required.push(field);
  }
  let bodyField: string | undefined;
  if (operation.body) {
    bodyField = uniqueInputField("body", used);
    const projected = projectSchema(operation.body.schema, true, `${operation.ref}/body/schema`);
    properties[bodyField] = projected.schema;
    losses.push(...projected.losses);
    if (operation.body.required) required.push(bodyField);
  }
  if (Object.keys(properties).length > 0) {
    result.input = {
      type: "object", properties, additionalProperties: false,
      ...(required.length > 0 ? { required: required.sort() } : {}),
    };
  }
  for (const response of operation.responses) {
    if (!response.canSucceed || !response.usable || !response.schemaPresent || !response.schema) continue;
    const projected = projectSchema(response.schema, false, `${response.sourceRef}/schema`);
    losses.push(...projected.losses);
    if (result.output === undefined) result.output = projected.schema;
    else if (isSchemaRecord(result.output) && Array.isArray(result.output.anyOf)) result.output.anyOf.push(projected.schema);
    else result.output = { anyOf: [result.output, projected.schema] };
  }
  const inputTransform = envelopeTransform(parameterFields, bodyField);
  return { operation: result, ...(inputTransform ? { inputTransform } : {}), losses };
}

function projectSchema(value: unknown, request: boolean, sourceRef: string): {
  schema: JSONSchema;
  losses: Swagger20ProjectionLoss[];
} {
  if (!isRecord(value)) throw new Error(`Swagger 2.0 schema at ${sourceRef} is not an object`);
  const allowed = new Set([
    "$ref", "$defs", "format", "title", "description", "default", "multipleOf", "maximum", "exclusiveMaximum",
    "minimum", "exclusiveMinimum", "maxLength", "minLength", "pattern", "maxItems", "minItems", "uniqueItems",
    "maxProperties", "minProperties", "required", "enum", "type", "items", "allOf", "properties", "additionalProperties",
  ]);
  const result: Record<string, unknown> = {};
  const losses: Swagger20ProjectionLoss[] = [];
  for (const [key, member] of Object.entries(value)) if (allowed.has(key)) result[key] = structuredClone(member);
  if (result.type === "file" || result.format === "binary" || result.format === "byte") {
    result.type = "string";
    result.contentEncoding = "base64";
    delete result.format;
  }
  projectExclusive(result, "maximum", "exclusiveMaximum");
  projectExclusive(result, "minimum", "exclusiveMinimum");
  for (const key of ["items", "additionalProperties"] as const) if (isRecord(value[key])) {
    const child = projectSchema(value[key], request, `${sourceRef}/${key}`);
    result[key] = child.schema;
    losses.push(...child.losses);
  }
  if (Array.isArray(value.allOf)) {
    result.allOf = value.allOf.map((branch, index) => {
      const child = projectSchema(branch, request, `${sourceRef}/allOf/${index}`);
      losses.push(...child.losses);
      return child.schema;
    });
  }
  for (const key of ["$defs"] as const) if (isRecord(value[key])) {
    const definitions: Record<string, JSONSchema> = {};
    for (const [name, definition] of Object.entries(value[key])) {
      const child = projectSchema(definition, request, `${sourceRef}/${key}/${escapePointer(name)}`);
      definitions[name] = child.schema;
      losses.push(...child.losses);
    }
    result[key] = definitions;
  }
  if (isRecord(value.properties)) {
    const properties: Record<string, JSONSchema> = {};
    const removed = new Set<string>();
    for (const [name, property] of Object.entries(value.properties)) {
      if (request && isRecord(property) && property.readOnly === true) { removed.add(name); continue; }
      const child = projectSchema(property, request, `${sourceRef}/properties/${escapePointer(name)}`);
      properties[name] = child.schema;
      losses.push(...child.losses);
    }
    result.properties = properties;
    if (Array.isArray(result.required) && removed.size > 0) {
      result.required = result.required.filter((name) => typeof name !== "string" || !removed.has(name));
      if (result.required.length === 0) delete result.required;
    }
  }
  if (Object.hasOwn(value, "discriminator")) losses.push({
    sourceRef: `${sourceRef}/discriminator`,
    reasonCode: "openapi20.discriminator_projection_loss",
    message: "the OAS 2.0 discriminator annotation has no Core JSON Schema assertion with equivalent artifact semantics",
  });
  return { schema: result as JSONSchema, losses };
}

function projectExclusive(result: Record<string, unknown>, limit: string, exclusive: string): void {
  if (typeof result[exclusive] !== "boolean") return;
  const enabled = result[exclusive] === true;
  delete result[exclusive];
  if (enabled && Object.hasOwn(result, limit)) {
    result[exclusive] = result[limit];
    delete result[limit];
  }
}

function envelopeTransform(parameters: Record<string, string>, bodyField: string | undefined): string | undefined {
  if (Object.keys(parameters).length === 0 && bodyField === undefined) return undefined;
  const parameterObject = `{${Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right)).map(
    ([key, field]) => `${JSON.stringify(key)}:$lookup($,${JSON.stringify(field)})`,
  ).join(",")}}`;
  const parameterValue = "$count($keys($parameters)) > 0 ? $parameters : undefined()";
  const bodyValue = bodyField === undefined ? "undefined()"
    : `$exists($lookup($,${JSON.stringify(bodyField)})) ? $lookup($,${JSON.stringify(bodyField)}) : undefined()`;
  return `($parameters := ${parameterObject}; {"parameters":${parameterValue},"body":${bodyValue}})`;
}

function alternativeCoverage(
  operation: Swagger20SynthesisOperation,
  operationKey: string,
  bindingKey: string,
): SynthesisCoverageEntry[] {
  const result: SynthesisCoverageEntry[] = [];
  for (const alternative of operation.alternatives) {
    if (alternative.kind === "security" || (alternative.kind === "server" && alternative.usable)) continue;
    result.push(alternativeEntry(operation, alternative, operationKey, bindingKey));
  }
  for (const security of operation.security) if (!security.usable) result.push({
    sourceIndex: 0, sourceRef: security.sourceRef, scope: "alternative", status: "excluded",
    reasonCode: "openapi20.security_alternative_excluded", rule: "OAPI20-P-04",
    message: security.reason ?? "security alternative is unusable", requirements: [],
  });
  for (const response of operation.responses) for (const header of response.headers) {
    if (header.usable) result.push({
      sourceIndex: 0, sourceRef: header.sourceRef, scope: "projection", status: "represented",
      operationKey, bindingKey, bindingSelector: operation.ref, requirements: [],
    });
    else result.push({
      sourceIndex: 0, sourceRef: header.sourceRef, scope: "projection", status: "excluded",
      reasonCode: "openapi20.response_header_excluded", rule: "OAPI20-P-03",
      message: header.reason ?? "response header is unusable", requirements: [],
    });
  }
  return result;
}

function alternativeEntry(
  operation: Swagger20SynthesisOperation,
  alternative: Swagger20SynthesisAlternative,
  operationKey: string,
  bindingKey: string,
): SynthesisCoverageEntry {
  if (alternative.usable) return {
    sourceIndex: 0, sourceRef: alternative.sourceRef, scope: "alternative", status: "represented",
    operationKey, bindingKey, bindingSelector: operation.ref,
    requirements: sortedUnique(alternative.requirements),
  };
  return {
    sourceIndex: 0, sourceRef: alternative.sourceRef, scope: "alternative", status: "excluded",
    reasonCode: `openapi20.${alternative.kind}_excluded`,
    rule: alternative.kind === "server" || alternative.kind === "security" ? "OAPI20-P-04" : "OAPI20-P-03",
    message: alternative.reason ?? `${alternative.kind} alternative is unusable`, requirements: [],
  };
}

function excludedTarget(operation: Swagger20SynthesisOperation): SynthesisCoverageEntry {
  const reason = operation.reason ?? "target is unusable";
  const lower = reason.toLowerCase();
  const rule = /response|consumes|produces|payload/u.test(lower) ? "OAPI20-P-03"
    : /security|scheme|host|server/u.test(lower) ? "OAPI20-P-04"
      : /parameter|path template/u.test(lower) ? "OAPI20-P-02" : "OAPI20-P-01";
  return {
    sourceIndex: 0, sourceRef: operation.ref, scope: "target", status: "excluded",
    reasonCode: "openapi20.target_excluded", rule, message: reason, requirements: [],
  };
}

function uniqueInputField(base: string, used: Set<string>): string {
  if (!used.has(base)) { used.add(base); return base; }
  for (let index = 2; ; index++) {
    const candidate = `${base}_${index}`;
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
  }
}

function sortedUnique(values: string[]): string[] { return [...new Set(values.filter(Boolean))].sort(); }
function escapePointer(value: string): string { return value.replaceAll("~", "~0").replaceAll("/", "~1"); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function isSchemaRecord(value: unknown): value is Record<string, unknown> { return isRecord(value); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

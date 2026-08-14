import type { OBInterface, Operation, Source } from "@openbindings/sdk";
import { MAX_TESTED_VERSION, canonicalize, validateInterface } from "@openbindings/sdk";
import { decircularizeSchema, decycleOperationSchema } from "./decycle.js";
import type {
  AsyncAPIChannel,
  AsyncAPIDocument,
  AsyncAPIMessage,
  AsyncAPIOperation,
  AsyncAPIOperationReply,
} from "./asyncapi-types.js";
import {
  BINDING_SPEC,
  DEFAULT_SOURCE_NAME,
} from "./constants.js";
import { codePointCompare, operationRef, sanitizeKey, uniqueKey } from "./util.js";
import { governingMessages, isJSONMediaType, messageEffectiveContentType, parseMedia, supportedMessageContentType } from "./content.js";
import { translateSchemaDialect } from "./translate.js";
import { effectiveServers } from "./target.js";

// eslint-disable-next-line @typescript-eslint/require-await -- the synthesizer contract is Promise-returning; this format synthesizes synchronously
export async function convertToInterface(
  location?: string,
  content?: AsyncAPIDocument,
  _options?: { signal?: AbortSignal },
  bindingSpec = BINDING_SPEC,
): Promise<OBInterface> {
  if (!content) throw new Error("asyncapi convertToInterface: content is required");
  const doc = content;

  const sourceEntry: Source = {
    bindingSpec,
  };
  if (location) sourceEntry.location = location;

  const info = doc.info;
  const iface: OBInterface = {
    openbindings: MAX_TESTED_VERSION,
    name: info.title || undefined,
    // OBI version is optional but non-empty when present (minLength 1); an
    // artifact declaring an empty version projects to no version field, the
    // same emission Go's omitempty produces.
    version: info.version || undefined,
    description: info.description || undefined,
    operations: {},
    bindings: {},
    sources: { [DEFAULT_SOURCE_NAME]: sourceEntry },
  };

  const usedKeys = new Set<string>();
  const ops = bindableOperationEntries(doc, bindingSpec);
  // Sort by id, code point order, for deterministic output
  ops.sort(([a], [b]) => codePointCompare(a, b));

  for (const [opID, asyncOp] of ops) {
    const opKey = uniqueKey(sanitizeKey(opID), usedKeys);
    usedKeys.add(opKey);

    const obiOp: Operation = {
      description: asyncOp.description || asyncOp.summary || undefined,
    };

    const tags = asyncOp.tags;
    if (tags && tags.length) {
      obiOp.tags = tags.map((t) => t.name);
    }

    // Schema direction follows the complementary perspective (ASYNC-P-02):
    // the artifact describes the application, the invocation is the
    // counterparty. Cyclic-reference hoisting runs on each direction so
    // recursion the artifact declared survives the projection ($defs,
    // decycle.ts).
    const { input, output } = operationBoundarySchemas(doc, asyncOp);
    const opPointer = `#/operations/${escapePointerSegment(opKey)}`;
    if (input) obiOp.input = decycleOperationSchema(input, doc, `${opPointer}/input`);
    if (output) obiOp.output = decycleOperationSchema(output, doc, `${opPointer}/output`);

    iface.operations[opKey] = obiOp;

    const ref = operationRef(opID);
    const bindingKey = `${opKey}.${DEFAULT_SOURCE_NAME}`;
    iface.bindings![bindingKey] = {
      operation: opKey,
      source: DEFAULT_SOURCE_NAME,
      ref,
    };
  }

  if (Object.keys(iface.bindings ?? {}).length === 0) delete iface.bindings;

  return iface;
}

/** Shared creation-time eligibility for synthesis and inspection. */
export function bindableOperationEntries(
  doc: AsyncAPIDocument,
  bindingSpec = BINDING_SPEC,
): Array<[string, AsyncAPIOperation]> {
  return Object.entries(doc.operations ?? {})
    .filter(([, operation]) => operationBindable(doc, operation, bindingSpec))
    .sort(([a], [b]) => codePointCompare(a, b));
}

export interface AuthoringExclusion {
  status: "excluded" | "invalid" | "implementation-unsupported";
  code: string;
  rule: string;
  message: string;
}

function operationBindable(
  doc: AsyncAPIDocument,
  op: AsyncAPIOperation,
  bindingSpec: string,
): boolean {
  return operationExclusion(doc, op, bindingSpec) === undefined;
}

export function operationExclusion(
  doc: AsyncAPIDocument,
  op: AsyncAPIOperation,
  _bindingSpec = BINDING_SPEC,
): AuthoringExclusion | undefined {
  const unresolvedTrait = (op as unknown as Record<string, unknown>)["x-ob-asyncapi-unresolved-trait"];
  if (typeof unresolvedTrait === "string") {
    return {
      status: "invalid", code: "asyncapi.unresolved_operation_trait", rule: "ASYNC-D-03",
      message: `the operation trait reference ${JSON.stringify(unresolvedTrait)} does not resolve`,
    };
  }
  const unresolvedRef = (op as unknown as Record<string, unknown>)["$ref"];
  if (typeof unresolvedRef === "string") {
    return {
      status: "invalid", code: "asyncapi.dangling_operation_ref", rule: "ASYNC-D-03",
      message: "the operations-map reference does not resolve to an operation object",
    };
  }
  if (op.action !== "send" && op.action !== "receive") {
    return {
      status: "invalid", code: "asyncapi.invalid_action", rule: "ASYNC-D-03",
      message: "the operation action is neither send nor receive",
    };
  }
  const channel = op.channel;
  if (!channel || typeof (channel as unknown as Record<string, unknown>)["$ref"] === "string") {
    return {
      status: "invalid", code: "asyncapi.dangling_channel_ref", rule: "ASYNC-D-03",
      message: "the operation channel reference does not resolve",
    };
  }
  // A missing server is reachability configuration, not target identity
  // (ruled 2026-08-13, R1+R5): the operation is represented with a
  // configuration.server requirement and invocation challenges
  // CONTEXT_REQUIRED (config.value, point server) before dispatch.

  const operationMessages = governingMessages(op, channel);
  if (operationMessages.length === 0) {
    return {
      status: "excluded", code: "asyncapi.no_resolved_messages", rule: "ASYNC-P-03",
      message: "the operation has no resolved message declaration",
    };
  }
  const replyMessages = op.reply
    ? (op.reply.messages?.length ? op.reply.messages : Object.values(op.reply.channel?.messages ?? {}))
    : [];
  if (op.reply && replyMessages.length === 0) {
    return {
      status: "excluded", code: "asyncapi.no_resolved_reply_messages", rule: "ASYNC-P-03",
      message: "the operation declares a reply but no reply message resolves",
    };
  }
  const inputMessages = op.action === "receive" ? operationMessages : replyMessages;
  const outputMessages = op.action === "send" ? operationMessages : replyMessages;
  if (inputMessages.length > 0 && inputMessages.every((message) => message.headers !== undefined)) {
    return {
      status: "excluded", code: "asyncapi.message_headers", rule: "ASYNC-P-03",
      message: "every caller-input message declares application headers the first candidate cannot carry at the ordinary value boundary",
    };
  }
  if (outputMessages.some((message) => message.headers !== undefined)) {
    return {
      status: "excluded", code: "asyncapi.message_headers", rule: "ASYNC-P-03",
      message: "a possible caller-output message declares application headers the first candidate cannot carry at the ordinary value boundary",
    };
  }
  return operationSchemaDefect(doc, op);
}

export function messageBindable(
  _doc: AsyncAPIDocument,
  message: AsyncAPIMessage,
): boolean {
  if ((message as unknown as Record<string, unknown>)["x-ob-asyncapi-unresolved-trait"] !== undefined) return false;
  if (message.headers !== undefined) return false;
  return typeof (message as unknown as Record<string, unknown>)["$ref"] !== "string";
}

export function replyMessagesBindable(
  doc: AsyncAPIDocument,
  operation: AsyncAPIOperation,
): boolean {
  if (!operation.reply) return true;
  const messages = operation.reply.messages?.length
    ? operation.reply.messages
    : Object.values(operation.reply.channel?.messages ?? {});
  return messages.length > 0 && messages.every((message) => messageBindable(doc, message));
}

export function wsFieldsMayBeStrings(channel: AsyncAPIChannel): boolean {
  return requiredPropertiesMayBeStrings(channel.bindings?.ws?.query) && requiredPropertiesMayBeStrings(channel.bindings?.ws?.headers);
}

export function requiredPropertiesMayBeStrings(schema: Record<string, unknown> | undefined): boolean {
  if (!schema) return true;
  const required = Array.isArray(schema["required"]) ? schema["required"].filter((value): value is string => typeof value === "string") : [];
  const properties = schema["properties"] !== null && typeof schema["properties"] === "object" && !Array.isArray(schema["properties"])
    ? schema["properties"] as Record<string, unknown>
    : {};
  for (const name of required) {
    if (!Object.hasOwn(properties, name)) return false;
    const property = properties[name];
    if (property !== null && typeof property === "object" && !Array.isArray(property)) {
      const type = (property as Record<string, unknown>)["type"];
      if (type !== undefined && type !== "string") return false;
    }
  }
  return true;
}

/**
 * Derives both directions' operation-boundary schemas under the
 * complementary caller perspective (ASYNC-P-02): a send operation's messages
 * are the invoker's output, a receive operation's the invoker's input, and a
 * declared reply is the opposite direction (Go twin: operationBoundarySchemas).
 */
function operationBoundarySchemas(
  doc: AsyncAPIDocument,
  op: AsyncAPIOperation,
): { input?: Record<string, unknown>; output?: Record<string, unknown> } {
  switch (op.action) {
    case "send":
      return {
        output: operationPayloadSchema(doc, op, false),
        input: op.reply ? replyPayloadSchema(doc, op.reply) : undefined,
      };
    case "receive":
      return {
        input: operationPayloadSchema(doc, op, true),
        output: op.reply ? replyPayloadSchema(doc, op.reply) : undefined,
      };
    default:
      return {};
  }
}

/**
 * The §9.2 confinement gate (Go twin: operationSchemaDefect): a payload
 * declaration that projects to an ill-formed OBI schema — invalid under its
 * own declared dialect, or a reference the artifact leaves dangling —
 * excludes exactly this operation, never its siblings and never the
 * artifact. The check validates a single-operation probe interface with the
 * core validator so the judgment is the same one the emitted document would
 * face (OBI-D-16/D-17).
 */
function operationSchemaDefect(
  doc: AsyncAPIDocument,
  op: AsyncAPIOperation,
): AuthoringExclusion | undefined {
  const { input, output } = operationBoundarySchemas(doc, op);
  if (!input && !output) return undefined;
  const probeOp: Operation = {};
  if (input) probeOp.input = decycleOperationSchema(input, doc, "#/operations/probe/input");
  if (output) probeOp.output = decycleOperationSchema(output, doc, "#/operations/probe/output");
  const probe: OBInterface = {
    openbindings: MAX_TESTED_VERSION,
    name: "probe",
    version: "0.0.0",
    operations: { probe: probeOp },
  };
  try {
    validateInterface(probe);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "invalid",
      code: "asyncapi.payload_schema_invalid",
      rule: "ASYNC-P-05",
      message: `the payload declaration does not project to a well-formed OBI schema: ${message}`,
    };
  }
  return undefined;
}

function escapePointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function operationPayloadSchema(doc: AsyncAPIDocument, op: AsyncAPIOperation, input: boolean): Record<string, unknown> | undefined {
  const channel = op.channel!;
  const governed = governingMessages(op, channel);
  const messages = input ? governed.filter((message) => message.headers === undefined) : governed;
  return unionPayloadSchemas(doc, messages);
}

function replyPayloadSchema(doc: AsyncAPIDocument, reply: AsyncAPIOperationReply): Record<string, unknown> | undefined {
  const messages = (reply.messages?.length ? reply.messages : Object.values(reply.channel?.messages ?? {}))
    .filter((message) => message.headers === undefined);
  return unionPayloadSchemas(doc, messages);
}

// Each governed payload enters an OBI position only under dialect
// translation (translate.ts); a message whose declared schemaFormat or
// effective content type identifies a non-JSON-Schema representation cannot
// contribute a faithful schema, so the direction is represented by the
// unconstrained schema per the binding specification's §9.2 floor.
// Declaration-driven only — never payload sniffing.
function unionPayloadSchemas(doc: AsyncAPIDocument, messages: AsyncAPIMessage[]): Record<string, unknown> | undefined {
  if (messages.length === 0) return undefined;
  if (messages.some((message) => messagePayloadNotConvertible(doc, message))) return {};
  const unique = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    const { schema: effectiveSchema, schemaFormat } = effectivePayload(message);
    let schema: Record<string, unknown>;
    if (messageCarriage(doc, message) === "bytes") {
      // The byte boundary: exact octets as the canonical Base64 string,
      // regardless of any declared (inexpressible) payload contract.
      schema = base64BoundarySchema();
    } else {
      // Cut object-graph cycles into $ref form before any recursive walk —
      // translation and serialization would otherwise recurse forever on a
      // payload the reference pipeline terminated by sharing (decycle.ts).
      // Decircularize FIRST: the shallow strip copy would break the root's
      // identity with its components entry and move the cut point.
      const stripped = stripParserExtensions(decircularizeSchema(effectiveSchema!, doc));
      schema = classifySchemaFormat(schemaFormat) === "translate" ? translateSchemaDialect(stripped) : stripped;
    }
    // JSON object member order is not semantic. Use canonical JSON both for
    // de-duplication and anyOf ordering so source spelling cannot make the
    // TypeScript and Go projections disagree.
    unique.set(canonicalize(schema) ?? JSON.stringify(schema), schema);
  }
  const schemas = [...unique.entries()].sort(([a], [b]) => codePointCompare(a, b)).map(([, schema]) => schema);
  return schemas.length === 1 ? schemas[0] : { anyOf: schemas };
}

/**
 * Resolves the schema a message actually declares, across the editions' two
 * spellings: AsyncAPI 2.x message-level schemaFormat governing payload
 * directly, versus AsyncAPI 3.x's Multi Format Schema Object
 * (payload: {schemaFormat, schema}). Discrimination follows the 3.x spec's
 * own rule — a payload object carrying a string schemaFormat member IS the
 * wrapper (Go twin: effectivePayload in authoring.go).
 */
export function effectivePayload(message: AsyncAPIMessage): {
  schema: Record<string, unknown> | undefined;
  schemaFormat: string | undefined;
} {
  const payload = message.payload as Record<string, unknown> | undefined;
  if (payload !== undefined && typeof payload["schemaFormat"] === "string") {
    const wrapped = payload["schema"];
    return {
      schema:
        wrapped !== null && typeof wrapped === "object" && !Array.isArray(wrapped)
          ? (wrapped as Record<string, unknown>)
          : undefined,
      schemaFormat: payload["schemaFormat"],
    };
  }
  return { schema: payload, schemaFormat: message.schemaFormat };
}

// The EMISSION predicate: whether the direction must be the unconstrained
// schema. Whether anything was LOST is messagePayloadLossReason's separate
// question — an absent payload declares no contract, so the unconstrained
// schema loses nothing (Go twin: authoring.go).
export function messagePayloadNotConvertible(doc: AsyncAPIDocument, message: AsyncAPIMessage): boolean {
  // Byte carriage is never unconstrained: the direction is represented by
  // the canonical Base64 boundary schema (unionPayloadSchemas emits it).
  if (messageCarriage(doc, message) === "bytes") return false;
  if (effectivePayload(message).schema === undefined) return true;
  return messagePayloadLossReason(doc, message) !== undefined;
}

/**
 * Classifies the effective content type's application-value carriage: JSON
 * family and text ride the ordinary value boundary; any other syntactically
 * valid media type is the artifact-authorized byte rule (canonical Base64
 * boundary); a malformed declaration is invalid (Go twin: messageCarriage).
 */
export function messageCarriage(doc: AsyncAPIDocument, message: AsyncAPIMessage): "json" | "text" | "bytes" | "invalid" {
  return contentTypeCarriage(messageEffectiveContentType(doc, message));
}

export function contentTypeCarriage(contentType: string): "json" | "text" | "bytes" | "invalid" {
  if (contentType.trim() === "") return "json";
  let parsed;
  try {
    parsed = parseMedia(contentType);
  } catch {
    return "invalid";
  }
  const textual = isJSONMediaType(parsed.type) || parsed.type.startsWith("text/");
  if (textual) {
    const charset = parsed.parameters.get("charset")?.trim().toLowerCase();
    if (charset && charset !== "utf-8" && charset !== "utf8") return "invalid";
    return parsed.type.startsWith("text/") ? "text" : "json";
  }
  return "bytes";
}

/**
 * The byte rule's boundary contract: the caller's JSON string is canonical
 * RFC 4648 §4 Base64 of the exact octets.
 */
export function base64BoundarySchema(): Record<string, unknown> {
  return { type: "string", contentEncoding: "base64" };
}

function schemaEqualsBoundary(schema: Record<string, unknown>, disposition: SchemaFormatDisposition): boolean {
  const carried = disposition === "translate" ? translateSchemaDialect(schema) : schema;
  return canonicalize(carried) === canonicalize(base64BoundarySchema());
}

/**
 * Names the lossy-coverage reason when the floored direction discards an
 * author-declared contract, or undefined when nothing is lost. The two
 * causes carry different authority and remediation, so they account under
 * distinct codes: a foreign schema language versus a content type whose
 * bytes the JSON value boundary cannot carry.
 */
export function messagePayloadLossReason(doc: AsyncAPIDocument, message: AsyncAPIMessage): string | undefined {
  const { schema, schemaFormat } = effectivePayload(message);
  if (schema === undefined && message.payload === undefined) return undefined;
  if (messageCarriage(doc, message) === "bytes") {
    // The byte boundary (§9.2, ruled 2026-08-13): declared binary media
    // carries exact octets as the canonical Base64 boundary string. With no
    // declared payload contract — or one that IS the boundary schema —
    // nothing is lost. Any other declared contract is not expressible at
    // that boundary, so the direction is lossy; consumer codec hooks are
    // the enrichment path (Go twin: messagePayloadLossReason).
    if (!hasForeignSchemaFormat(schemaFormat)) {
      if (schema === undefined) return undefined;
      if (schemaEqualsBoundary(schema, classifySchemaFormat(schemaFormat))) return undefined;
    }
    return "asyncapi.payload_byte_carriage";
  }
  if (hasForeignSchemaFormat(schemaFormat)) return "asyncapi.schema_format_not_convertible";
  return undefined;
}

/**
 * Exact schema-format classification, replacing the substring heuristic
 * (which accepted bogus formats and applied Draft-07 rules to other
 * dialects). Pinned set and semantics mirror the Go twin
 * (classifySchemaFormat in authoring.go): AsyncAPI default formats and
 * schema+json;version=draft-07 translate; schema+json;version=draft/2020-12
 * passes through untouched; everything else — Avro, Protobuf, OpenAPI,
 * unknown or malformed versions — is foreign.
 */
export type SchemaFormatDisposition = "translate" | "passthrough" | "foreign";

export function classifySchemaFormat(declared: string | undefined): SchemaFormatDisposition {
  const trimmed = declared?.trim() ?? "";
  if (trimmed === "") return "translate";
  const [rawType, ...params] = trimmed.split(";");
  const mediaType = rawType!.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mediaType)) return "foreign";
  let version = "";
  for (const param of params) {
    const eq = param.indexOf("=");
    if (eq < 0) return "foreign";
    const name = param.slice(0, eq).trim().toLowerCase();
    let value = param.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    if (name === "version") version = value.toLowerCase();
  }
  switch (mediaType) {
    case "application/vnd.aai.asyncapi":
    case "application/vnd.aai.asyncapi+json":
    case "application/vnd.aai.asyncapi+yaml":
      return "translate";
    case "application/schema+json":
    case "application/schema+yaml":
      if (version === "draft-07") return "translate";
      if (version === "draft/2020-12") return "passthrough";
      return "foreign";
    default:
      return "foreign";
  }
}

function hasForeignSchemaFormat(declared: string | undefined): boolean {
  return classifySchemaFormat(declared) === "foreign";
}

/**
 * Remove x-parser-* extension keys from a schema object (shallow top-level only).
 * These may appear in source documents; they shouldn't leak into OBI output.
 */
function stripParserExtensions(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("x-parser-")) continue;
    result[k] = v;
  }
  return result;
}

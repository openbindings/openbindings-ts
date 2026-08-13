import type { OBInterface, Operation, Source } from "@openbindings/sdk";
import { MAX_TESTED_VERSION, canonicalize } from "@openbindings/sdk";
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
import { governingMessages, messageEffectiveContentType, supportedMessageContentType } from "./content.js";
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
    version: info.version,
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
    // counterparty.
    const action = asyncOp.action;
    switch (action) {
      case "send":
        {
          // The application sends; invoking subscribes — the operation's
          // messages are the invoker's OUTPUT.
          const payload = operationPayloadSchema(doc, asyncOp, false);
          if (payload) obiOp.output = payload;
          if (asyncOp.reply) {
            const replyPayload = replyPayloadSchema(doc, asyncOp.reply);
            if (replyPayload) obiOp.input = replyPayload;
          }
        }
        break;
      case "receive":
        {
          // The application receives; invoking publishes — the operation's
          // messages are the invoker's INPUT, and a declared reply is what
          // the publish's response decodes to.
          const inputPayload = operationPayloadSchema(doc, asyncOp, true);
          if (inputPayload) obiOp.input = inputPayload;
          const reply = asyncOp.reply;
          if (reply) {
            const outputPayload = replyPayloadSchema(doc, reply);
            if (outputPayload) obiOp.output = outputPayload;
          }
        }
        break;
    }

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
  if (effectiveServers(doc, channel).length === 0) {
    return {
      status: "excluded", code: "asyncapi.no_effective_server", rule: "ASYNC-P-04",
      message: "the operation has no effective artifact-declared server or protocol",
    };
  }

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
  // Carriage gate: when every caller-input message rides a content type with
  // no JSON application-value carriage, the runtime refuses before dispatch
  // (no input codec seam exists). Presenting the operation as invocable would
  // be a lie, so the target is implementation-unsupported — visible MC2 debt
  // discharged by a codec extension path (Go twin: operationExclusion).
  if (
    inputMessages.length > 0
    && inputMessages.every(
      (message) => messagePayloadLossReason(doc, message) === "asyncapi.payload_carriage_unsupported",
    )
  ) {
    return {
      status: "implementation-unsupported", code: "asyncapi.payload_carriage_unsupported", rule: "ASYNC-P-05",
      message: "every caller-input message declares media without JSON application-value carriage; invocation would refuse before dispatch until a codec extension path exists",
    };
  }
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
  return undefined;
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
    const stripped = stripParserExtensions(effectiveSchema!);
    const schema = classifySchemaFormat(schemaFormat) === "translate" ? translateSchemaDialect(stripped) : stripped;
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
  if (effectivePayload(message).schema === undefined) return true;
  return messagePayloadLossReason(doc, message) !== undefined;
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
  if (hasForeignSchemaFormat(schemaFormat)) return "asyncapi.schema_format_not_convertible";
  // A wrapper whose schema member is absent declares no contract in a
  // recognized language.
  if (schema === undefined) return undefined;
  try {
    supportedMessageContentType(messageEffectiveContentType(doc, message));
    return undefined;
  } catch {
    return "asyncapi.payload_carriage_unsupported";
  }
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

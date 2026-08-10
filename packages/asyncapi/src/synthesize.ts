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
  preservesSendReplies,
} from "./constants.js";
import { codePointCompare, operationRef, sanitizeKey, uniqueKey } from "./util.js";
import {
  decodeContentType,
  governingMessages,
  messageEffectiveContentType,
  supportedMessageContentType,
} from "./content.js";
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
    name: info.title ?? undefined,
    version: info.version,
    description: info.description ?? undefined,
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
  status: "excluded" | "invalid";
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
  bindingSpec = BINDING_SPEC,
): AuthoringExclusion | undefined {
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
  const httpVersion = op.bindings?.http?.bindingVersion;
  if (httpVersion !== undefined && httpVersion !== "0.3.0") {
    return {
      status: "excluded", code: "asyncapi.unsupported_http_binding_version", rule: "ASYNC-P-02",
      message: "the HTTP operation binding version is outside revision 1",
    };
  }
  const wsVersion = channel.bindings?.ws?.bindingVersion;
  if (wsVersion !== undefined && wsVersion !== "0.1.0") {
    return {
      status: "excluded", code: "asyncapi.unsupported_websocket_binding_version", rule: "ASYNC-P-02",
      message: "the WebSocket channel binding version is outside revision 1",
    };
  }
  const protocols = new Set(
    effectiveServers(doc, channel).map(({ server }) => server.protocol.toLowerCase()),
  );
  const hasHTTP = protocols.has("http") || protocols.has("https");
  const hasWS = protocols.has("ws") || protocols.has("wss");

  if (op.action === "receive") {
    const messages = authoringInputMessages(op, channel).filter((message) => messageBindable(doc, message));
    if (messages.length === 0) {
      return {
        status: "excluded", code: "asyncapi.no_bindable_message", rule: "ASYNC-P-03",
        message: "the publish interaction has no message alternative revision 1 can carry",
      };
    }
    const httpOK = hasHTTP
      && Boolean(op.bindings?.http?.method?.trim())
      && requiredPropertiesMayBeStrings(op.bindings?.http?.query)
      && replyMessagesBindable(doc, op);
    const wsOK = hasWS && op.reply === undefined && wsFieldsMayBeStrings(channel);
    if (!httpOK && !wsOK) {
      return {
        status: "excluded", code: "asyncapi.no_faithful_protocol_cell", rule: "ASYNC-P-02",
        message: "neither the HTTP publish nor WebSocket publish cell is faithfully representable",
      };
    }
    return undefined;
  }

  if (!hasWS) {
    return {
      status: "excluded", code: "asyncapi.no_faithful_protocol_cell", rule: "ASYNC-P-02",
      message: "the operation's effective server set provides no WebSocket subscription cell",
    };
  }
  if (op.reply && preservesSendReplies(bindingSpec)) {
    return {
      status: "excluded", code: "asyncapi.websocket_reply", rule: "ASYNC-P-02",
      message: "reply-bearing WebSocket send operations require request/reply session semantics revision 2 does not define",
    };
  }
  if (!wsFieldsMayBeStrings(channel)) {
    return {
      status: "excluded", code: "asyncapi.protocol_fields_unrepresentable", rule: "ASYNC-P-04",
      message: "required WebSocket protocol fields do not admit string values",
    };
  }
  if (Object.values(channel.parameters ?? {}).some((parameter) => typeof parameter.location === "string" && parameter.location !== "")) {
    return {
      status: "excluded", code: "asyncapi.subscription_parameter_location", rule: "ASYNC-P-04",
      message: "a subscription channel parameter declares a location revision 1 cannot preserve",
    };
  }
  const messages = governingMessages(op, channel);
  if (messages.length === 0) {
    return {
      status: "excluded", code: "asyncapi.no_resolved_messages", rule: "ASYNC-P-03",
      message: "the subscription interaction has no resolved message declaration",
    };
  }
  if (messages.some((message) => !messageBindable(doc, message))) {
    return {
      status: "excluded", code: "asyncapi.unbindable_subscription_message", rule: "ASYNC-P-03",
      message: "a subscription message alternative uses carriage outside revision 1",
    };
  }
  try {
    decodeContentType(doc, messages, { configuration: { decode: "json" } });
    return undefined;
  } catch (error: unknown) {
    return {
      status: "excluded", code: "asyncapi.ambiguous_subscription_content_type", rule: "ASYNC-P-05",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function authoringInputMessages(op: AsyncAPIOperation, channel: AsyncAPIChannel): AsyncAPIMessage[] {
  return governingMessages(op, channel);
}

export function messageBindable(
  doc: AsyncAPIDocument,
  message: AsyncAPIMessage,
): boolean {
  if (message.headers !== undefined) return false;
  const version = message.bindings?.http?.bindingVersion;
  if (version !== undefined && version !== "0.3.0") return false;
  try {
    supportedMessageContentType(messageEffectiveContentType(doc, message));
    return true;
  } catch {
    return false;
  }
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
  const messages = input
    ? authoringInputMessages(op, channel).filter((message) => messageBindable(doc, message))
    : governingMessages(op, channel);
  return unionPayloadSchemas(messages);
}

function replyPayloadSchema(doc: AsyncAPIDocument, reply: AsyncAPIOperationReply): Record<string, unknown> | undefined {
  const messages = (reply.messages?.length ? reply.messages : Object.values(reply.channel?.messages ?? {}))
    .filter((message) => messageBindable(doc, message));
  return unionPayloadSchemas(messages);
}

function unionPayloadSchemas(messages: AsyncAPIMessage[]): Record<string, unknown> | undefined {
  if (messages.length === 0 || messages.some((message) => message.payload === undefined)) return undefined;
  const unique = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    const schema = stripParserExtensions(message.payload!);
    // JSON object member order is not semantic. Use canonical JSON both for
    // de-duplication and anyOf ordering so source spelling cannot make the
    // TypeScript and Go projections disagree.
    unique.set(canonicalize(schema) ?? JSON.stringify(schema), schema);
  }
  const schemas = [...unique.entries()].sort(([a], [b]) => codePointCompare(a, b)).map(([, schema]) => schema);
  return schemas.length === 1 ? schemas[0] : { anyOf: schemas };
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

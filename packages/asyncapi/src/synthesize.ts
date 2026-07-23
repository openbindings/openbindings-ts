import type { OBInterface, Operation, Source } from "@openbindings/sdk";
import { MAX_TESTED_VERSION } from "@openbindings/sdk";
import type {
  AsyncAPIChannel,
  AsyncAPIDocument,
  AsyncAPIMessage,
  AsyncAPIOperation,
  AsyncAPIOperationReply,
} from "./asyncapi-types.js";
import { BINDING_SPEC, DEFAULT_SOURCE_NAME } from "./constants.js";
import { codePointCompare, operationRef, sanitizeKey, uniqueKey } from "./util.js";
import { decodeContentType, governingMessages } from "./content.js";

// eslint-disable-next-line @typescript-eslint/require-await -- the synthesizer contract is Promise-returning; this format synthesizes synchronously
export async function convertToInterface(
  location?: string,
  content?: AsyncAPIDocument,
  _options?: { signal?: AbortSignal },
): Promise<OBInterface> {
  if (!content) throw new Error("asyncapi convertToInterface: content is required");
  const doc = content;

  const sourceEntry: Source = {
    bindingSpec: BINDING_SPEC,
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
  const ops = bindableOperationEntries(doc);
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
          const payload = operationPayloadSchema(asyncOp, false);
          if (payload) obiOp.output = payload;
        }
        break;
      case "receive":
        {
          // The application receives; invoking publishes — the operation's
          // messages are the invoker's INPUT, and a declared reply is what
          // the publish's response decodes to.
          const inputPayload = operationPayloadSchema(asyncOp, true);
          if (inputPayload) obiOp.input = inputPayload;
          const reply = asyncOp.reply;
          if (reply) {
            const outputPayload = replyPayloadSchema(reply);
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

  return iface;
}

/** Shared creation-time eligibility for synthesis and inspection. */
export function bindableOperationEntries(doc: AsyncAPIDocument): Array<[string, AsyncAPIOperation]> {
  return Object.entries(doc.operations ?? {})
    .filter(([, operation]) => operationBindable(doc, operation))
    .sort(([a], [b]) => codePointCompare(a, b));
}

function operationBindable(doc: AsyncAPIDocument, op: AsyncAPIOperation): boolean {
  const unresolvedRef = (op as unknown as Record<string, unknown>)["$ref"];
  if (typeof unresolvedRef === "string" || (op.action !== "send" && op.action !== "receive")) return false;
  const channel = op.channel;
  if (!channel || typeof (channel as unknown as Record<string, unknown>)["$ref"] === "string") return false;
  const httpVersion = op.bindings?.http?.bindingVersion;
  if (httpVersion !== undefined && httpVersion !== "0.3.0") return false;
  const wsVersion = channel.bindings?.ws?.bindingVersion;
  if (wsVersion !== undefined && wsVersion !== "0.1.0") return false;

  if (op.action === "receive") {
    const messages = authoringInputMessages(op, channel).filter(messageBindable);
    if (messages.length === 0) return false;
    const httpOK = Boolean(op.bindings?.http?.method?.trim()) && requiredPropertiesMayBeStrings(op.bindings?.http?.query);
    const wsOK = op.reply === undefined && wsFieldsMayBeStrings(channel);
    return httpOK || wsOK;
  }

  if (!wsFieldsMayBeStrings(channel)) return false;
  if (Object.values(channel.parameters ?? {}).some((parameter) => typeof parameter.location === "string" && parameter.location !== "")) return false;
  const messages = governingMessages(op, channel);
  if (messages.length === 0 || messages.some((message) => !messageBindable(message))) return false;
  try {
    decodeContentType(doc, messages, { configuration: { decode: "json" } });
    return true;
  } catch {
    return false;
  }
}

function authoringInputMessages(op: AsyncAPIOperation, channel: AsyncAPIChannel): AsyncAPIMessage[] {
  return governingMessages(op, channel);
}

function messageBindable(message: AsyncAPIMessage): boolean {
  if (message.headers !== undefined) return false;
  const version = message.bindings?.http?.bindingVersion;
  return version === undefined || version === "0.3.0";
}

function wsFieldsMayBeStrings(channel: AsyncAPIChannel): boolean {
  return requiredPropertiesMayBeStrings(channel.bindings?.ws?.query) && requiredPropertiesMayBeStrings(channel.bindings?.ws?.headers);
}

function requiredPropertiesMayBeStrings(schema: Record<string, unknown> | undefined): boolean {
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

function operationPayloadSchema(op: AsyncAPIOperation, input: boolean): Record<string, unknown> | undefined {
  const channel = op.channel!;
  const messages = input
    ? authoringInputMessages(op, channel).filter(messageBindable)
    : governingMessages(op, channel);
  return unionPayloadSchemas(messages);
}

function replyPayloadSchema(reply: AsyncAPIOperationReply): Record<string, unknown> | undefined {
  const messages = (reply.messages?.length ? reply.messages : Object.values(reply.channel?.messages ?? {})).filter(messageBindable);
  return unionPayloadSchemas(messages);
}

function unionPayloadSchemas(messages: AsyncAPIMessage[]): Record<string, unknown> | undefined {
  if (messages.length === 0 || messages.some((message) => message.payload === undefined)) return undefined;
  const unique = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    const schema = stripParserExtensions(message.payload!);
    unique.set(JSON.stringify(schema), schema);
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

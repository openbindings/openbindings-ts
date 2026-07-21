import type { OBInterface, Operation, Source } from "@openbindings/sdk";
import { MAX_TESTED_VERSION } from "@openbindings/sdk";
import type {
  AsyncAPIDocument,
  AsyncAPIOperation,
  AsyncAPIOperationReply,
} from "./asyncapi-types.js";
import { BINDING_SPEC, DEFAULT_SOURCE_NAME } from "./constants.js";
import { operationRef, sanitizeKey, uniqueKey } from "./util.js";

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
  const ops = Object.entries(doc.operations ?? {});
  // Sort by id for deterministic output
  ops.sort(([a], [b]) => a.localeCompare(b));

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
          const payload = resolveOperationPayload(asyncOp);
          if (payload) obiOp.output = payload;
        }
        break;
      case "receive":
        {
          // The application receives; invoking publishes — the operation's
          // messages are the invoker's INPUT, and a declared reply is what
          // the publish's response decodes to.
          const inputPayload = resolveOperationPayload(asyncOp);
          if (inputPayload) obiOp.input = inputPayload;
          const reply = asyncOp.reply;
          if (reply) {
            const outputPayload = resolveReplyPayload(reply);
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

function resolveOperationPayload(
  op: AsyncAPIOperation,
): Record<string, unknown> | undefined {
  // Try operation-level messages first (after dereference these are resolved objects)
  const opMsgs = op.messages;
  if (opMsgs && opMsgs.length > 0) {
    const payload = opMsgs[0].payload;
    if (payload) return stripParserExtensions(payload);
  }

  // Fall back to channel messages
  const channel = op.channel;
  if (channel?.messages) {
    const channelMsgs = Object.values(channel.messages);
    for (const msg of channelMsgs) {
      const payload = msg.payload;
      if (payload) return stripParserExtensions(payload);
    }
  }

  return undefined;
}

function resolveReplyPayload(
  reply: AsyncAPIOperationReply,
): Record<string, unknown> | undefined {
  const replyMsgs = reply.messages;
  if (replyMsgs && replyMsgs.length > 0) {
    const payload = replyMsgs[0].payload;
    if (payload) return stripParserExtensions(payload);
  }
  return undefined;
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

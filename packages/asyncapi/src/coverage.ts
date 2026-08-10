import type {
  OBInterface,
  SynthesisCoverageEntry,
} from "@openbindings/sdk";
import type {
  AsyncAPIChannel,
  AsyncAPIDocument,
  AsyncAPIMessage,
  AsyncAPIOperation,
} from "./asyncapi-types.js";
import {
  BINDING_SPEC,
  CHANNEL_NAME_TAG,
  CHANNEL_REF_TAG,
  DEFAULT_SOURCE_NAME,
  MESSAGE_NAME_TAG,
  MESSAGE_REF_TAG,
  preservesSendReplies,
} from "./constants.js";
import { decodeContentType, governingMessages } from "./content.js";
import {
  type AuthoringExclusion,
  messageBindable,
  operationExclusion,
  replyMessagesBindable,
  requiredPropertiesMayBeStrings,
  wsFieldsMayBeStrings,
} from "./synthesize.js";
import { defaultServer, effectiveServers, isBoundProtocol } from "./target.js";
import { codePointCompare, operationRef } from "./util.js";

interface BindingIdentity {
  operationKey: string;
  bindingRef: string;
}

interface ObservedMessage {
  sourceRef: string;
  message?: AsyncAPIMessage;
}

/** Inventories operations plus independently selectable message/server cells. */
export function synthesisCoverage(
  doc: AsyncAPIDocument,
  iface: OBInterface,
): SynthesisCoverageEntry[] {
  const bindingSpec = iface.sources?.[DEFAULT_SOURCE_NAME]?.bindingSpec ?? BINDING_SPEC;
  const represented = new Map<string, BindingIdentity>();
  for (const binding of Object.values(iface.bindings ?? {})) {
    represented.set(binding.ref ?? "", {
      operationKey: binding.operation,
      bindingRef: binding.ref ?? "",
    });
  }

  const entries: SynthesisCoverageEntry[] = [];
  const operations = Object.entries(doc.operations ?? {})
    .sort(([a], [b]) => codePointCompare(a, b));
  for (const [operationID, operation] of operations) {
    const ref = operationRef(operationID);
    const identity = represented.get(ref);
    const exclusion = operationExclusion(doc, operation, bindingSpec);
    if (exclusion) {
      entries.push(coverageExclusion(ref, "target", exclusion));
    } else if (!identity) {
      entries.push({
        sourceIndex: 0,
        sourceRef: ref,
        scope: "target",
        status: "implementation-unsupported",
        reasonCode: "asyncapi.missing_emitted_binding",
        message: "the synthesizer returned without emitting this bindable operation",
      });
    } else {
      entries.push({
        sourceIndex: 0,
        sourceRef: ref,
        scope: "target",
        status: "represented",
        ...identity,
        requirements: operationRequirements(doc, operation),
      });
    }

    const channel = operation.channel;
    if (!channel || typeof (channel as unknown as Record<string, unknown>)["$ref"] === "string") continue;
    for (const candidate of governingMessageInventory(operation, channel, `${ref}#message`)) {
      entries.push(messageCoverage(doc, candidate, identity, exclusion));
    }
    if (operation.reply) {
      for (const candidate of replyMessageInventory(operation, `${ref}#reply-message`)) {
        entries.push(messageCoverage(doc, candidate, identity, exclusion));
      }
    }
    for (const [index, member] of effectiveServers(doc, channel).entries()) {
      const sourceRef = `${ref}#server[${index}]=${member.name}`;
      const protocol = member.server.protocol.toLowerCase();
      if (!isBoundProtocol(protocol)) {
        entries.push({
          sourceIndex: 0,
          sourceRef,
          scope: "alternative",
          status: "excluded",
          reasonCode: "asyncapi.protocol_outside_revision",
          rule: "ASYNC-P-02",
          message: `server protocol ${JSON.stringify(member.server.protocol)} is outside revision 1`,
        });
        continue;
      }
      const cell = protocolCellExclusion(doc, operation, channel, protocol, bindingSpec);
      if (cell) {
        entries.push(coverageExclusion(sourceRef, "alternative", cell));
      } else if (identity) {
        entries.push({
          sourceIndex: 0,
          sourceRef,
          scope: "alternative",
          status: "represented",
          ...identity,
        });
      } else {
        entries.push({
          sourceIndex: 0,
          sourceRef,
          scope: "alternative",
          status: "excluded",
          reasonCode: "asyncapi.parent_target_excluded",
          rule: "ASYNC-P-02",
          message: "the governing operation has no faithfully representable target",
        });
      }
    }
  }
  return entries;
}

function coverageExclusion(
  sourceRef: string,
  scope: "target" | "alternative",
  exclusion: AuthoringExclusion,
): SynthesisCoverageEntry {
  return {
    sourceIndex: 0,
    sourceRef,
    scope,
    status: exclusion.status,
    reasonCode: exclusion.code,
    rule: exclusion.rule,
    message: exclusion.message,
  };
}

function operationRequirements(
  doc: AsyncAPIDocument,
  operation: AsyncAPIOperation,
): string[] | undefined {
  const requirements: string[] = [];
  if (!defaultServer(effectiveServers(doc, operation.channel))) {
    requirements.push("configuration.server");
  }
  if (
    operation.action === "receive"
    && governingMessages(operation, operation.channel).length > 1
  ) {
    requirements.push("configuration.message");
  }
  return requirements.length > 0 ? requirements : undefined;
}

function governingMessageInventory(
  operation: AsyncAPIOperation,
  channel: AsyncAPIChannel,
  prefix: string,
): ObservedMessage[] {
  if (operation.messages && operation.messages.length > 0) {
    return operation.messages.map((message, index) => ({
      sourceRef: `${prefix}[${index}]=${messageIdentity(message, index)}`,
      message: unresolvedMessage(message) ? undefined : message,
    }));
  }
  return Object.entries(channel.messages ?? {})
    .sort(([a], [b]) => codePointCompare(a, b))
    .map(([name, message], index) => ({
      sourceRef: `${prefix}[${index}]=${channelSourceRef(channel)}/messages/${name}`,
      message: unresolvedMessage(message) ? undefined : message,
    }));
}

function replyMessageInventory(
  operation: AsyncAPIOperation,
  prefix: string,
): ObservedMessage[] {
  const reply = operation.reply;
  if (!reply) return [];
  if (reply.messages && reply.messages.length > 0) {
    return reply.messages.map((message, index) => ({
      sourceRef: `${prefix}[${index}]=${messageIdentity(message, index)}`,
      message: unresolvedMessage(message) ? undefined : message,
    }));
  }
  if (!reply.channel) return [];
  if (typeof (reply.channel as unknown as Record<string, unknown>)["$ref"] === "string") {
    return [{ sourceRef: `${prefix}=<dangling-reply-channel>` }];
  }
  return Object.entries(reply.channel.messages ?? {})
    .sort(([a], [b]) => codePointCompare(a, b))
    .map(([name, message], index) => ({
      sourceRef: `${prefix}[${index}]=${channelSourceRef(reply.channel!)}/messages/${name}`,
      message: unresolvedMessage(message) ? undefined : message,
    }));
}

function messageCoverage(
  doc: AsyncAPIDocument,
  candidate: ObservedMessage,
  identity: BindingIdentity | undefined,
  parentExclusion: AuthoringExclusion | undefined,
): SynthesisCoverageEntry {
  if (!candidate.message) {
    return {
      sourceIndex: 0,
      sourceRef: candidate.sourceRef,
      scope: "alternative",
      status: "invalid",
      reasonCode: "asyncapi.dangling_message_ref",
      rule: "ASYNC-D-03",
      message: "the message reference does not resolve",
    };
  }
  if (candidate.message.headers !== undefined) {
    return {
      sourceIndex: 0,
      sourceRef: candidate.sourceRef,
      scope: "alternative",
      status: "excluded",
      reasonCode: "asyncapi.message_headers",
      rule: "ASYNC-P-03",
      message: "revision 1 cannot carry AsyncAPI message headers",
    };
  }
  const version = candidate.message.bindings?.http?.bindingVersion;
  if (version !== undefined && version !== "0.3.0") {
    return {
      sourceIndex: 0,
      sourceRef: candidate.sourceRef,
      scope: "alternative",
      status: "excluded",
      reasonCode: "asyncapi.unsupported_message_binding_version",
      rule: "ASYNC-P-02",
      message: "the HTTP message binding version is outside revision 1",
    };
  }
  if (!messageBindable(doc, candidate.message)) {
    return {
      sourceIndex: 0,
      sourceRef: candidate.sourceRef,
      scope: "alternative",
      status: "excluded",
      reasonCode: "asyncapi.message_content_type_unrepresentable",
      rule: "ASYNC-P-03",
      message: "the message content type has no revision-1 value carriage",
    };
  }
  if (identity) {
    return {
      sourceIndex: 0,
      sourceRef: candidate.sourceRef,
      scope: "alternative",
      status: "represented",
      ...identity,
    };
  }
  return {
    sourceIndex: 0,
    sourceRef: candidate.sourceRef,
    scope: "alternative",
    status: "excluded",
    reasonCode: "asyncapi.parent_target_excluded",
    rule: parentExclusion?.rule ?? "ASYNC-P-02",
    message: parentExclusion?.message
      ?? "the governing operation has no faithfully representable target",
  };
}

function protocolCellExclusion(
  doc: AsyncAPIDocument,
  operation: AsyncAPIOperation,
  channel: AsyncAPIChannel,
  protocol: string,
  bindingSpec: string,
): AuthoringExclusion | undefined {
  if (protocol === "http" || protocol === "https") {
    if (operation.action === "send") {
      return {
        status: "excluded", code: "asyncapi.standalone_http_send", rule: "ASYNC-P-02",
        message: "standalone HTTP send is outside revision 1",
      };
    }
    if (!operation.bindings?.http?.method?.trim()) {
      return {
        status: "excluded", code: "asyncapi.http_method_unresolved", rule: "ASYNC-P-02",
        message: "the HTTP publish cell has no artifact-declared method",
      };
    }
    if (!requiredPropertiesMayBeStrings(operation.bindings.http.query)) {
      return {
        status: "excluded", code: "asyncapi.protocol_fields_unrepresentable", rule: "ASYNC-P-04",
        message: "required HTTP protocol fields do not admit string values",
      };
    }
    if (!replyMessagesBindable(doc, operation)) {
      return {
        status: "excluded", code: "asyncapi.reply_carriage_unrepresentable", rule: "ASYNC-P-05",
        message: "an HTTP reply message uses carriage outside revision 1",
      };
    }
    return undefined;
  }
  if (operation.reply && (operation.action === "receive" || preservesSendReplies(bindingSpec))) {
    return {
      status: "excluded", code: "asyncapi.websocket_reply", rule: "ASYNC-P-02",
      message: "reply-bearing WebSocket operations require request/reply session semantics this revision does not define",
    };
  }
  if (!wsFieldsMayBeStrings(channel)) {
    return {
      status: "excluded", code: "asyncapi.protocol_fields_unrepresentable", rule: "ASYNC-P-04",
      message: "required WebSocket protocol fields do not admit string values",
    };
  }
  if (operation.action === "send") {
    if (Object.values(channel.parameters ?? {}).some(
      (parameter) => typeof parameter.location === "string" && parameter.location !== "",
    )) {
      return {
        status: "excluded", code: "asyncapi.subscription_parameter_location", rule: "ASYNC-P-04",
        message: "a subscription channel parameter declares a location revision 1 cannot preserve",
      };
    }
    const messages = governingMessages(operation, channel);
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
    } catch (error: unknown) {
      return {
        status: "excluded", code: "asyncapi.ambiguous_subscription_content_type", rule: "ASYNC-P-05",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return undefined;
}

function unresolvedMessage(message: AsyncAPIMessage): boolean {
  return typeof (message as unknown as Record<string, unknown>)["$ref"] === "string";
}

function messageIdentity(message: AsyncAPIMessage, index: number): string {
  const raw = message as unknown as Record<string, unknown>;
  const ref = raw["$ref"];
  if (typeof ref === "string") return ref;
  const sourceRef = raw[MESSAGE_REF_TAG];
  if (typeof sourceRef === "string") return sourceRef;
  const tagged = raw[MESSAGE_NAME_TAG];
  if (typeof tagged === "string") return tagged;
  return message.name ?? `<inline:${index}>`;
}

function channelName(channel: AsyncAPIChannel): string {
  const tagged = (channel as unknown as Record<string, unknown>)[CHANNEL_NAME_TAG];
  return typeof tagged === "string" ? tagged : "<inline>";
}

function channelSourceRef(channel: AsyncAPIChannel): string {
  const external = (channel as unknown as Record<string, unknown>)[CHANNEL_REF_TAG];
  if (typeof external === "string" && external !== "") return external;
  return `#/channels/${channelName(channel)}`;
}

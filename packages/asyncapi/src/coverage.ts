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
} from "./constants.js";
import { governingMessages } from "./content.js";
import {
  type AuthoringExclusion,
  messageBindable,
  messagePayloadLossReason,
  operationExclusion,
} from "./synthesize.js";
import { defaultServer, effectiveServers } from "./target.js";
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
    const exclusion = operationExclusion(doc, operation, operationID, bindingSpec);
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
      if (identity) {
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
  if (!messageBindable(doc, candidate.message)) {
    return {
      sourceIndex: 0,
      sourceRef: candidate.sourceRef,
      scope: "alternative",
      status: "excluded",
      reasonCode: "asyncapi.message_unresolvable",
      rule: "ASYNC-P-03",
      message: "the message declaration does not resolve faithfully",
    };
  }
  if (identity) {
    // The §9.2 floor: a declared non-JSON-Schema representation keeps the
    // operation invocable through an unconstrained direction, but the
    // emitted OBI has lost a contract bespoke artifact code still knows.
    // That is lossy, never fully represented (Go twin: messageCoverage).
    // Carriage loss splits off: the runtime refuses that alternative before
    // dispatch today, so it is implementation-unsupported — never presented
    // as usable — until the codec extension path exists.
    const lossReason = messagePayloadLossReason(doc, candidate.message);
    if (lossReason === "asyncapi.payload_carriage_unsupported") {
      return {
        sourceIndex: 0,
        sourceRef: candidate.sourceRef,
        scope: "alternative",
        status: "implementation-unsupported",
        ...identity,
        reasonCode: lossReason,
        rule: "ASYNC-P-05",
        message: "the effective content type has no JSON application-value carriage; invocation refuses this alternative before dispatch",
      };
    }
    if (lossReason !== undefined) {
      return {
        sourceIndex: 0,
        sourceRef: candidate.sourceRef,
        scope: "alternative",
        status: "lossy",
        ...identity,
        reasonCode: lossReason,
        rule: "ASYNC-P-05",
        message: "the declared schema format has no faithful JSON Schema conversion; the direction is represented by the unconstrained schema",
      };
    }
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

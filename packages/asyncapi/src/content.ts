/**
 * The governing content-type declarations of openbindings.asyncapi@1 §9.1
 * (ASYNC-P-03, input encoding) and §9.3 (ASYNC-P-05, decode). Effective
 * content type resolves PER MESSAGE first — the message's own
 * `contentType`, else the document's `defaultContentType`, the AsyncAPI
 * rule — and the governing set's distinct effective types decide the lane.
 * Only JSON-family and UTF-8 text-family declarations have revision-1 value
 * carriage; binary codecs are refused rather than mapped to strings.
 * Everything here is decided by declarations, never payload bytes. Mirrors
 * the Go SDK's content.go.
 */

import type {
  AsyncAPIChannel,
  AsyncAPIDocument,
  AsyncAPIMessage,
  AsyncAPIOperation,
} from "./asyncapi-types.js";
import { contextConfiguration } from "@openbindings/sdk";
import { MESSAGE_NAME_TAG } from "./constants.js";

/**
 * Returns the operation's own governing message set — the declarations
 * governing a subscription's outputs and a publish's input encoding: the
 * operation's `messages` (resolved), else ALL of the operation channel's
 * messages (the AsyncAPI rule for an operation that declares no
 * `messages`), in sorted key order for determinism. A message `$ref` the
 * dereferencer could not resolve contributes nothing (the core's
 * partial-verification posture).
 */
export function governingMessages(
  op: AsyncAPIOperation | undefined,
  ch: AsyncAPIChannel | undefined,
): AsyncAPIMessage[] {
  const declared = op?.messages;
  if (declared && declared.length > 0) return declared.filter(isResolvedMessage);
  if (!ch) return [];
  return channelMessages(ch);
}

/** Resolves the publish-side `message` point to exactly one declaration. */
export function selectedInputMessages(
  op: AsyncAPIOperation | undefined,
  ch: AsyncAPIChannel | undefined,
  context?: Record<string, unknown>,
): AsyncAPIMessage[] {
  const messages = governingMessages(op, ch);
  if (messages.length === 0) throw new Error("publish operation has no resolved message declaration");
  let selected: AsyncAPIMessage;
  if (messages.length === 1) {
    selected = messages[0]!;
  } else {
    const choice = contextConfiguration(context)["message"];
    if (typeof choice !== "string" || choice === "") {
      throw new Error("publish operation declares several messages; configuration.message must select one artifact-declared member");
    }
    const matches = messages.filter((message) => messageName(message) === choice);
    if (matches.length !== 1) throw new Error(`configuration.message ${JSON.stringify(choice)} does not select exactly one operation message`);
    selected = matches[0]!;
  }
  if (selected.headers !== undefined) throw new Error("selected message declares headers, which this AsyncAPI binding revision cannot carry");
  return [selected];
}

function messageName(message: AsyncAPIMessage): string {
  const tagged = (message as unknown as Record<string, unknown>)[MESSAGE_NAME_TAG];
  if (typeof tagged === "string") return tagged;
  return message.name ?? "";
}

/**
 * Returns the REPLY-side governing message set — the declarations
 * governing a publish invocation's output (direction-correct decode,
 * ASYNC-P-05): the reply's `messages` (resolved), else the reply channel's
 * messages.
 */
export function replyGoverningMessages(op: AsyncAPIOperation | undefined): AsyncAPIMessage[] {
  const reply = op?.reply;
  if (!reply) return [];
  if (reply.messages && reply.messages.length > 0) return reply.messages.filter(isResolvedMessage);
  if (reply.channel) return channelMessages(reply.channel);
  return [];
}

/** A message list entry that resolved (a dangling `$ref` node — the shared
 *  dereferencer leaves those in place — contributes nothing). */
function isResolvedMessage(m: AsyncAPIMessage): boolean {
  return typeof (m as unknown as Record<string, unknown>).$ref !== "string";
}

/**
 * Returns a channel's messages in sorted key order (the map is unordered;
 * sorting is a determinism choice, and the distinct-set computation below
 * is order-insensitive anyway).
 */
function channelMessages(ch: AsyncAPIChannel): AsyncAPIMessage[] {
  const messages = ch.messages ?? {};
  return Object.entries(messages)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, m]) => m);
}

/**
 * Resolves each governing message's effective content type per the
 * AsyncAPI rule (its `contentType`, else the document's
 * `defaultContentType`) and returns the distinct set, in first-appearance
 * order. Types are normalized for the distinctness test (lowercased,
 * parameters stripped — a charset parameter never makes a type distinct).
 * A message resolving to no declaration at all contributes the empty type
 * as its own distinct member: a set mixing declared and undeclared
 * messages is ambiguous, never silently collapsed onto the declared type.
 */
export function distinctEffectiveTypes(
  doc: AsyncAPIDocument,
  msgs: AsyncAPIMessage[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of msgs) {
    const ct = m.contentType || doc.defaultContentType || "";
    const norm = normalizeMediaType(ct);
    if (!seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

/**
 * Collapses a governing set to the supported declaration the decode point
 * consults (§9.3, ASYNC-P-05). Binary/codec-specific media are refused.
 */
export function decodeContentType(
  doc: AsyncAPIDocument,
  msgs: AsyncAPIMessage[],
  context?: Record<string, unknown>,
): string {
  if (msgs.length === 0) throw new Error("operation has no resolved output message declaration");
  for (const message of msgs) {
    validateMessageBindingVersion(message);
    if (message.headers !== undefined) throw new Error("output message declares headers, which the candidate application-value boundary cannot carry");
    supportedMessageContentType(messageEffectiveContentType(doc, message));
  }
  const types = completeEffectiveTypes(doc, msgs);
  if (types.length > 1) throw new Error("output messages declare conflicting effective content types");
  const only = types[0] ?? "";
  if (only !== "") return only;
  return requiredLane(context, "decode");
}

/**
 * §9.1's resolved input encoding: the input value is the message payload,
 * wholesale (ASYNC-P-03), rendered per the governing request-side
 * declaration.
 */
export interface InputCodec {
  /** JSON serializes the value as JSON; otherwise the text lane applies (a
   *  string value sent raw; a non-string value is refused). */
  json: boolean;
  /** The declared type the wire carries ("" when the declaration is
   *  ambiguous and names no one type). */
  contentType: string;
}

/**
 * Resolves the input encoding from the governing request-side declaration
 * (§9.1, ASYNC-P-03): a JSON-family type serializes the value as JSON; a
 * supported text-family type carries a UTF-8 string. Binary/codec-specific
 * media and explicit non-UTF-8 charsets are refused: revision 1 has no
 * bytes value or common transcode surface. With no declaration,
 * configuration.encode must choose the JSON or text lane. More or fewer
 * than one selected message is refused; payload bytes never select among
 * artifact alternatives.
 */
export function resolveInputCodec(
  doc: AsyncAPIDocument,
  msgs: AsyncAPIMessage[],
  context?: Record<string, unknown>,
): InputCodec {
  if (msgs.length !== 1) throw new Error("publish input must be governed by exactly one selected message");
  const types = distinctEffectiveTypes(doc, msgs);
  if (types.length > 1) throw new Error("selected message has ambiguous effective content type");
  // Zero or one distinct type after the ambiguity return above; absent is "".
  const t = types[0] ?? "";
  if (t === "") {
    const lane = requiredLane(context, "encode");
    return { json: lane === "application/json", contentType: lane === "application/json" ? "application/json" : "text/plain; charset=utf-8" };
  }
  const effective = messageEffectiveContentType(doc, msgs[0]!);
  supportedMessageContentType(effective);
  if (isJSONMediaType(t)) return { json: true, contentType: effective };
  if (isTextContentType(t)) return { json: false, contentType: effective };
  throw new Error(`effective content type ${JSON.stringify(effective)} has no candidate application-value carriage`);
}

export function messageEffectiveContentType(
  doc: AsyncAPIDocument,
  message: AsyncAPIMessage,
): string {
  return message.contentType ?? doc.defaultContentType ?? "";
}

/**
 * Enforces revision 1's value boundary. JSON-family and UTF-8 text-family
 * media are representable; absence is completed by encode/decode
 * configuration. Binary codecs and non-UTF-8 charsets are not assigned an
 * invented bytes convention.
 */
export function supportedMessageContentType(contentType: string): void {
  if (contentType.trim() === "") return;
  const parsed = parseMedia(contentType);
  if (!isJSONMediaType(parsed.type) && !parsed.type.startsWith("text/")) {
    throw new Error(`effective content type ${JSON.stringify(contentType)} has no candidate application-value carriage`);
  }
  const charset = parsed.parameters.get("charset")?.trim().toLowerCase();
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    throw new Error(`effective content type ${JSON.stringify(contentType)} declares unsupported non-UTF-8 charset ${JSON.stringify(charset)}`);
  }
}

/** Selects the reply declaration governing a non-empty HTTP response. */
export function resolveReplyContentType(
  doc: AsyncAPIDocument,
  op: AsyncAPIOperation,
  status: number,
  actualContentType: string,
  context?: Record<string, unknown>,
): string {
  const all = replyGoverningMessages(op);
  if (all.length === 0) throw new Error("non-empty HTTP response has no artifact-declared reply message");
  const exact = all.filter((message) => message.bindings?.http?.statusCode === status);
  const candidates = exact.length > 0 ? exact : all.filter((message) => message.bindings?.http?.statusCode === undefined);
  if (candidates.length === 0) throw new Error(`non-empty HTTP ${status} response has no governing reply message`);
  for (const message of candidates) {
    validateMessageBindingVersion(message);
    if (message.headers !== undefined) throw new Error("selected reply message declares headers, which the candidate application-value boundary cannot carry");
    supportedMessageContentType(messageEffectiveContentType(doc, message));
  }

  const declared = candidates.map((message) => message.contentType ?? doc.defaultContentType ?? "");
  const nonempty = declared.filter((value) => value !== "");
  if (nonempty.length === 0) return requiredLane(context, "decode");
  if (actualContentType.trim() === "") throw new Error("reply candidates declare content types but the HTTP response has no Content-Type");
  const actual = parseMedia(actualContentType);
  const matches = nonempty
    .map((value) => ({ value, parsed: parseMedia(value) }))
    .filter(({ parsed }) => mediaSubset(parsed, actual));
  if (matches.length === 0) throw new Error(`HTTP response Content-Type ${JSON.stringify(actualContentType)} matches no reply declaration`);
  const specificity = Math.max(...matches.map(({ parsed }) => parsed.parameters.size));
  const best = matches.filter(({ parsed }) => parsed.parameters.size === specificity);
  const identities = new Set(best.map(({ parsed }) => parsed.identity));
  if (best.length !== 1 || identities.size !== 1) throw new Error("HTTP response matches several distinct reply media declarations at equal specificity");
  return best[0]!.value;
}

export function validateMessageBindingVersion(message: AsyncAPIMessage): void {
  const version = message.bindings?.http?.bindingVersion;
  if (version !== undefined && version !== "0.3.0") {
    throw new Error(`HTTP message binding version ${JSON.stringify(version)} is outside the candidate's incorporated 0.3.0 envelope`);
  }
}

function completeEffectiveTypes(doc: AsyncAPIDocument, msgs: AsyncAPIMessage[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const message of msgs) {
    const value = message.contentType ?? doc.defaultContentType ?? "";
    const identity = value === "" ? "" : parseMedia(value).identity;
    if (!seen.has(identity)) { seen.add(identity); result.push(value); }
  }
  return result;
}

function requiredLane(context: Record<string, unknown> | undefined, point: "encode" | "decode"): string {
  const value = contextConfiguration(context)[point];
  if (value === "json") return "application/json";
  if (value === "text") return "text/plain; charset=utf-8";
  throw new Error(`configuration.${point} must select "json" or "text" because the artifact declares no effective content type`);
}

interface ParsedMedia { type: string; parameters: Map<string, string>; identity: string }
export function parseMedia(value: string): ParsedMedia {
  const parts = value.split(";");
  const type = (parts.shift() ?? "").trim().toLowerCase();
  if (!type.includes("/")) throw new Error(`invalid media type ${JSON.stringify(value)}`);
  const parameters = new Map<string, string>();
  for (const part of parts) {
    const index = part.indexOf("=");
    if (index < 1) throw new Error(`invalid media type parameter in ${JSON.stringify(value)}`);
    const name = part.slice(0, index).trim().toLowerCase();
    let parameter = part.slice(index + 1).trim();
    if (parameter.startsWith('"') && parameter.endsWith('"')) parameter = parameter.slice(1, -1).replace(/\\(.)/g, "$1");
    parameters.set(name, parameter);
  }
  const identity = `${type};${[...parameters].sort(([a], [b]) => a.localeCompare(b)).map(([name, parameter]) => `${name}=${parameter}`).join(";")}`;
  return { type, parameters, identity };
}
function mediaSubset(declared: ParsedMedia, actual: ParsedMedia): boolean {
  if (declared.type !== actual.type) return false;
  for (const [name, value] of declared.parameters) if (actual.parameters.get(name) !== value) return false;
  return true;
}

/**
 * Renders one caller value as message-payload text under the resolved
 * codec: the JSON lane serializes; the text lane requires a string value
 * and sends it raw — a non-string value there is refused (§9.1).
 */
export function encodeInput(codec: InputCodec, v: unknown): string {
  if (codec.json) return JSON.stringify(v ?? null);
  if (typeof v !== "string") {
    throw new Error(
      `the governing declaration selects the text lane: the input value must be a string, got ${typeof v}`,
    );
  }
  if (!isWellFormedUnicode(v)) {
    throw new Error("the text-lane input is not valid UTF-8");
  }
  return v;
}

/** ES2022-compatible equivalent of String.prototype.isWellFormed(). */
export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * Lowercases a media type and strips its parameters: type/subtype matching
 * ignores parameters (a charset never changes the lane). Mirrors openapi's
 * normalizeMediaType (format packages do not share private helpers).
 */
export function normalizeMediaType(contentType: string): string {
  let mt = contentType.trim().toLowerCase();
  const i = mt.indexOf(";");
  if (i >= 0) mt = mt.slice(0, i).trim();
  return mt;
}

/**
 * Reports MIME's text family, the only declared non-JSON string lane in
 * revision 1.
 */
export function isTextContentType(contentType: string): boolean {
  return normalizeMediaType(contentType).startsWith("text/");
}

/**
 * The JSON media-type rule: application/json or any +json
 * structured-suffix type; absent/unparseable → NOT JSON. Never sniffed.
 * Operates on a normalized type.
 */
export function isJSONMediaType(normalized: string): boolean {
  return normalized === "application/json" || normalized.endsWith("+json");
}

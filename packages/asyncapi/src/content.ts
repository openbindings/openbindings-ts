/**
 * The governing content-type declarations of openbindings.asyncapi@1 §9.1
 * (ASYNC-P-03, input encoding) and §9.3 (ASYNC-P-05, decode). Effective
 * content type resolves PER MESSAGE first — the message's own
 * `contentType`, else the document's `defaultContentType`, the AsyncAPI
 * rule — and the governing set's distinct effective types decide the lane:
 * exactly one selects it; none, or more than one (an ambiguous
 * declaration), falls to the text lane rather than guessing. Everything
 * here is decided by declarations, never payload bytes. Mirrors the Go
 * SDK's content.go.
 */

import type {
  AsyncAPIChannel,
  AsyncAPIDocument,
  AsyncAPIMessage,
  AsyncAPIOperation,
} from "./asyncapi-types.js";

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
 * Collapses a governing set to the declaration the decode point consults
 * (§9.3, ASYNC-P-05): exactly one distinct effective type selects the lane
 * (strict JSON for application/json and +json, text otherwise); none, or
 * more than one distinct type, is the text lane ("" — builtinDecodeFor's
 * non-JSON lane), never a guess.
 */
export function decodeContentType(doc: AsyncAPIDocument, msgs: AsyncAPIMessage[]): string {
  const types = distinctEffectiveTypes(doc, msgs);
  const only = types.length === 1 ? types[0] : undefined;
  return only ?? "";
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
 * (§9.1, ASYNC-P-03): a JSON-family type — or no declaration at all, this
 * specification's default — serializes the value as JSON; a text-family
 * type sends a string value raw; any other declared family (binary, avro,
 * protobuf, …) is EXCLUDED from revision 1 and refused before dispatch. A
 * governing set with more than one distinct effective type is ambiguous
 * and falls to the text lane, mirroring §9.3's decode rule. Forwarded
 * frames on the duplex subscription cell use the same rule.
 */
export function resolveInputCodec(doc: AsyncAPIDocument, msgs: AsyncAPIMessage[]): InputCodec {
  const types = distinctEffectiveTypes(doc, msgs);
  if (types.length > 1) {
    return { json: false, contentType: "" }; // ambiguous → the text lane
  }
  // Zero or one distinct type after the ambiguity return above; absent is "".
  const t = types[0] ?? "";
  if (t === "") {
    // No declaration at all: JSON, the specification's default.
    return { json: true, contentType: "application/json" };
  }
  if (isJSONMediaType(t)) return { json: true, contentType: t };
  if (isTextContentType(t)) return { json: false, contentType: t };
  throw new Error(
    `declared content type ${JSON.stringify(t)} is neither a JSON- nor a text-family type: excluded from openbindings.asyncapi@1 revision 1 and refused before dispatch`,
  );
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
  return v;
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
 * Reports a text-family type: the `text/*` primary type. Application-tree
 * types that happen to be textual (application/xml, …) are NOT the text
 * family — on the input side they are excluded families (§9.1); on the
 * decode side everything non-JSON is the text lane anyway.
 */
export function isTextContentType(contentType: string): boolean {
  return normalizeMediaType(contentType).startsWith("text/");
}

/**
 * The JSON media-type rule: application/json or any +json
 * structured-suffix type; absent/unparseable → NOT JSON. Never sniffed.
 * Operates on a normalized type.
 */
function isJSONMediaType(normalized: string): boolean {
  return normalized === "application/json" || normalized.endsWith("+json");
}

import type { BindingInvocationArgs, ContextRequiredDetails, Metadata } from "@openbindings/sdk";

export interface DocumentConfiguration {
  source: string;
  operationName?: string;
}

export interface ProtocolConfiguration {
  httpHeaders: Record<string, string>;
  httpCookies: Record<string, string>;
  websocketHeaders: Record<string, string>;
  websocketCookies: Record<string, string>;
  connectionInitPayload?: Record<string, unknown> | null;
  connectionInitPayloadSet: boolean;
}

export interface GraphQLConfiguration {
  document?: DocumentConfiguration;
  subscriptionTarget?: string;
  protocol: ProtocolConfiguration;
}

const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

function record(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringMap(value: unknown, where: string): Record<string, string> {
  const raw = record(value, where);
  const out: Record<string, string> = {};
  for (const [name, item] of Object.entries(raw)) {
    if (typeof item !== "string") throw new Error(`${where}[${JSON.stringify(name)}] must be a string`);
    out[name] = item;
  }
  return out;
}

function documentConfiguration(value: unknown): DocumentConfiguration {
  if (typeof value === "string") {
    if (!value) throw new Error("configuration.document must supply non-empty GraphQL source text");
    return { source: value };
  }
  const raw = record(value, "configuration.document");
  for (const name of Object.keys(raw)) {
    if (name !== "source" && name !== "operationName") {
      throw new Error(`configuration.document member ${JSON.stringify(name)} is not defined`);
    }
  }
  if (typeof raw.source !== "string" || !raw.source) {
    throw new Error("configuration.document.source must be a non-empty string");
  }
  if (
    raw.operationName !== undefined
    && (typeof raw.operationName !== "string" || !GRAPHQL_NAME.test(raw.operationName))
  ) {
    throw new Error("configuration.document.operationName must be a GraphQL Name");
  }
  return {
    source: raw.source,
    ...(typeof raw.operationName === "string" ? { operationName: raw.operationName } : {}),
  };
}

export function readConfiguration(context: Record<string, unknown> | undefined): GraphQLConfiguration {
  if (hasUnnamedCredential(context)) {
    throw new Error("GraphQL does not infer protocol placement for generic credential context; supply the artifact's explicitly named header, cookie, or connection-init field through configuration.protocolFields");
  }
  const emptyProtocol = (): ProtocolConfiguration => ({
    httpHeaders: {},
    httpCookies: {},
    websocketHeaders: {},
    websocketCookies: {},
    connectionInitPayloadSet: false,
  });
  const rawConfiguration = context?.configuration;
  if (rawConfiguration === undefined) return { protocol: emptyProtocol() };
  const raw = record(rawConfiguration, "context.configuration");
  const result: GraphQLConfiguration = { protocol: emptyProtocol() };

  if (raw.document !== undefined) result.document = documentConfiguration(raw.document);
  if (raw.subscriptionTarget !== undefined) {
    if (typeof raw.subscriptionTarget !== "string" || !raw.subscriptionTarget) {
      throw new Error("configuration.subscriptionTarget must be a non-empty absolute ws or wss URI");
    }
    let parsed: URL;
    try {
      parsed = new URL(raw.subscriptionTarget);
    } catch {
      throw new Error("configuration.subscriptionTarget must be a non-empty absolute ws or wss URI");
    }
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new Error("configuration.subscriptionTarget must be a non-empty absolute ws or wss URI");
    }
    result.subscriptionTarget = raw.subscriptionTarget;
  }
  if (raw.protocolFields !== undefined) {
    const fields = record(raw.protocolFields, "configuration.protocolFields");
    const allowed = new Set([
      "httpHeaders", "httpCookies", "websocketHeaders", "websocketCookies", "connectionInitPayload",
    ]);
    for (const name of Object.keys(fields)) {
      if (!allowed.has(name)) throw new Error(`configuration.protocolFields member ${JSON.stringify(name)} is not defined`);
    }
    if (fields.httpHeaders !== undefined) {
      result.protocol.httpHeaders = stringMap(fields.httpHeaders, "configuration.protocolFields.httpHeaders");
    }
    if (fields.httpCookies !== undefined) {
      result.protocol.httpCookies = stringMap(fields.httpCookies, "configuration.protocolFields.httpCookies");
    }
    if (fields.websocketHeaders !== undefined) {
      result.protocol.websocketHeaders = stringMap(fields.websocketHeaders, "configuration.protocolFields.websocketHeaders");
    }
    if (fields.websocketCookies !== undefined) {
      result.protocol.websocketCookies = stringMap(fields.websocketCookies, "configuration.protocolFields.websocketCookies");
    }
    if (Object.hasOwn(fields, "connectionInitPayload")) {
      if (
        fields.connectionInitPayload !== null
        && (typeof fields.connectionInitPayload !== "object" || Array.isArray(fields.connectionInitPayload))
      ) {
        throw new Error("configuration.protocolFields.connectionInitPayload must be an object or null");
      }
      result.protocol.connectionInitPayload =
        fields.connectionInitPayload as Record<string, unknown> | null;
      result.protocol.connectionInitPayloadSet = true;
    }
  }
  return result;
}

function hasUnnamedCredential(context: Record<string, unknown> | undefined): boolean {
  if (!context) return false;
  for (const name of ["bearerToken", "apiKey", "accessToken"]) {
    if (typeof context[name] === "string" && context[name] !== "") return true;
  }
  const basic = context.basic;
  if (basic !== null && typeof basic === "object" && !Array.isArray(basic)) {
    const value = basic as Record<string, unknown>;
    if (typeof value.username === "string" || typeof value.password === "string") return true;
  }
  const apiKeys = context.apiKeys;
  return apiKeys !== null
    && typeof apiKeys === "object"
    && !Array.isArray(apiKeys)
    && Object.keys(apiKeys).length > 0;
}

const HTTP_OWNED = new Set(["content-type", "accept", "content-length", "host"]);
const WEBSOCKET_OWNED = new Set([
  "host", "connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol",
]);

function contextStringMap(context: Record<string, unknown> | undefined, name: string): Record<string, string> {
  const value = context?.[name];
  return value === undefined ? {} : stringMap(value, `context.${name}`);
}

function effectiveHeaders(
  explicit: Record<string, string>,
  contextual: Record<string, string>,
  cookies: Record<string, string>,
  contextualCookies: Record<string, string>,
  owned: Set<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Map<string, string>();
  const add = (name: string, value: string, origin: string) => {
    const folded = name.toLowerCase();
    if (owned.has(folded)) throw new Error(`${origin} header ${JSON.stringify(name)} collides with a processor-owned field`);
    const prior = seen.get(folded);
    if (prior) throw new Error(`${origin} header ${JSON.stringify(name)} collides with ${prior}`);
    seen.set(folded, origin);
    out[name] = value;
  };
  for (const [name, value] of Object.entries(contextual)) add(name, value, "context.headers");
  for (const [name, value] of Object.entries(explicit)) add(name, value, "configuration.protocolFields");

  const allCookies = new Map(Object.entries(contextualCookies));
  for (const [name, value] of Object.entries(cookies)) {
    if (allCookies.has(name)) throw new Error(`cookie ${JSON.stringify(name)} is supplied more than once`);
    allCookies.set(name, value);
  }
  if (allCookies.size > 0) {
    const prior = seen.get("cookie");
    if (prior) throw new Error(`cookie entries collide with raw Cookie header from ${prior}`);
    out.Cookie = [...allCookies].sort(([a], [b]) => codePointCompare(a, b))
      .map(([name, value]) => `${name}=${value}`).join("; ");
  }
  return out;
}

function codePointCompare(a: string, b: string): number {
  const aa = [...a];
  const bb = [...b];
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
    const ca = aa[i]!.codePointAt(0)!;
    const cb = bb[i]!.codePointAt(0)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return aa.length - bb.length;
}

export function httpHeaders(config: GraphQLConfiguration, context: Record<string, unknown> | undefined): Record<string, string> {
  return effectiveHeaders(
    config.protocol.httpHeaders,
    contextStringMap(context, "headers"),
    config.protocol.httpCookies,
    contextStringMap(context, "cookies"),
    HTTP_OWNED,
  );
}

export function websocketHeaders(config: GraphQLConfiguration): Record<string, string> {
  return effectiveHeaders(
    config.protocol.websocketHeaders,
    {},
    config.protocol.websocketCookies,
    {},
    WEBSOCKET_OWNED,
  );
}

export function validateHTTPLocation(location: string | undefined): string {
  if (!location) throw new Error("GraphQL source location must be an absolute http or https URI");
  let parsed: URL;
  try {
    parsed = new URL(location);
  } catch {
    throw new Error("GraphQL source location must be an absolute http or https URI");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("GraphQL source location must be an absolute http or https URI");
  }
  return location;
}

export function configurationRequirement(target: string, point: string, description: string): ContextRequiredDetails {
  return {
    target,
    alternatives: [{
      requirements: [{ type: "config.value", point, path: "", description }],
    }],
  };
}

export interface GraphQLWebSocketInit {
  url: string;
  protocols: string[];
  headers: Record<string, string>;
}

export type GraphQLWebSocketFactory = (init: GraphQLWebSocketInit) => WebSocket;

export function emptyMetadata(): Metadata {
  return {};
}

export function wantsCallerInput(args: Pick<BindingInvocationArgs, "inputSchema">): boolean {
  return args.inputSchema !== undefined;
}

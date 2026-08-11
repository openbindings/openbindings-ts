/** AsyncAPI 3.x document root. */
export interface AsyncAPIDocument {
  asyncapi: string;
  /** Fallback message contentType when a message declares none of its own:
   *  the per-message EFFECTIVE content type is the message's `contentType`,
   *  else this document default (the AsyncAPI rule, consumed by the
   *  governing-set computation in content.ts per ASYNC-P-03/-05). */
  defaultContentType?: string;
  info: AsyncAPIInfo;
  servers?: Record<string, AsyncAPIServer>;
  channels?: Record<string, AsyncAPIChannel>;
  operations?: Record<string, AsyncAPIOperation>;
  components?: AsyncAPIComponents;
}

export interface AsyncAPIInfo {
  title?: string;
  version: string;
  description?: string;
}

export interface AsyncAPIServer {
  host: string;
  protocol: string;
  pathname?: string;
  description?: string;
  /** Declared `{name}` expressions in host/pathname, substituted per
   *  ASYNC-P-04 (consumer-supplied value, else the declared default;
   *  unresolved is a pre-dispatch refusal). */
  variables?: Record<string, AsyncAPIServerVariable>;
  security?: AsyncAPISecurityRequirement[];
}

/** An AsyncAPI Server Variable Object. */
export interface AsyncAPIServerVariable {
  enum?: string[];
  default?: string;
  description?: string;
}

export interface AsyncAPIChannel {
  address?: string | null;
  messages?: Record<string, AsyncAPIMessage>;
  description?: string;
  /** The channel's declared server subset. After dereferencing these are
   *  resolved server objects carrying SERVER_NAME_TAG (see constants.ts);
   *  an entry whose `$ref` did not resolve keeps its `$ref` and
   *  contributes nothing to the effective set. */
  servers?: AsyncAPIServerRefOrObject[];
  parameters?: Record<string, AsyncAPIParameter>;
  bindings?: AsyncAPIChannelBindings;
}

/** A channel `servers` entry: the resolved Server Object after
 *  dereferencing, or a dangling `$ref` node left unresolved. */
export type AsyncAPIServerRefOrObject = AsyncAPIServer | { $ref: string };

/** An AsyncAPI Parameter Object (channel address `{name}` expression). */
export interface AsyncAPIParameter {
  description?: string;
  default?: string;
  enum?: string[];
  location?: string;
  schema?: Record<string, unknown>;
}

/** The protocol entries of a channel's `bindings` object this
 *  specification incorporates (§8: bindings are authoritative where they
 *  speak). Only the websockets binding speaks at channel level in
 *  revision 1. */
export interface AsyncAPIChannelBindings {
  ws?: AsyncAPIWSChannelBinding;
}

/** The AsyncAPI WebSockets channel binding: `method` selects the upgrade
 *  request's method, and `query`/`headers` are Schema Objects declaring
 *  the upgrade request's query parameters and headers (ASYNC-P-02: values
 *  supplied like address parameters, any unsatisfied required declaration
 *  a pre-dispatch refusal). */
export interface AsyncAPIWSChannelBinding {
  method?: string;
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  bindingVersion?: string;
}

export interface AsyncAPIOperation {
  action: "send" | "receive";
  channel?: AsyncAPIChannel;
  summary?: string;
  description?: string;
  messages?: AsyncAPIMessage[];
  reply?: AsyncAPIOperationReply;
  security?: AsyncAPISecurityRequirement[];
  bindings?: AsyncAPIOperationBindings;
  tags?: AsyncAPITag[];
}

/** The protocol entries of an operation's `bindings` object this
 *  specification incorporates. Only the http binding speaks at operation
 *  level in revision 1. */
export interface AsyncAPIOperationBindings {
  http?: AsyncAPIHTTPOperationBinding;
}

/** The AsyncAPI HTTP operation binding: its `method` selects the request
 *  method and is required for revision 1's HTTP publish cell (§8). */
export interface AsyncAPIHTTPOperationBinding {
  method?: string;
  query?: Record<string, unknown>;
  bindingVersion?: string;
}

export interface AsyncAPIOperationReply {
  channel?: AsyncAPIChannel;
  messages?: AsyncAPIMessage[];
}

export interface AsyncAPIMessage {
  name?: string;
  title?: string;
  summary?: string;
  description?: string;
  contentType?: string;
  schemaFormat?: string;
  payload?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  bindings?: { http?: { statusCode?: number; bindingVersion?: string } };
}

export interface AsyncAPIComponents {
  messages?: Record<string, AsyncAPIMessage>;
  schemas?: Record<string, Record<string, unknown>>;
  channels?: Record<string, AsyncAPIChannel>;
  securitySchemes?: Record<string, AsyncAPISecurityScheme>;
  servers?: Record<string, AsyncAPIServer>;
}

export interface AsyncAPISecurityScheme {
  type: string;
  description?: string;
  name?: string;
  in?: string;
  scheme?: string;
  bearerFormat?: string;
  flows?: AsyncAPIOAuthFlows;
}

export interface AsyncAPIOAuthFlows {
  implicit?: AsyncAPIOAuthFlow;
  password?: AsyncAPIOAuthFlow;
  clientCredentials?: AsyncAPIOAuthFlow;
  authorizationCode?: AsyncAPIOAuthFlow;
}

export interface AsyncAPIOAuthFlow {
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  scopes?: Record<string, string>;
}

export interface AsyncAPITag {
  name: string;
  description?: string;
}

export type AsyncAPISecurityRequirement = AsyncAPISecurityScheme | Record<string, string[]>;

/** Type-guard for an AsyncAPI security scheme. Resolved $ref-style entries
 *  carry a `type` field even after dereferencing into the scheme object. */
export function isSecurityScheme(obj: unknown): obj is AsyncAPISecurityScheme {
  return typeof obj === "object" && obj !== null && "type" in obj;
}

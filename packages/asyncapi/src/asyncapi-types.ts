/** AsyncAPI 3.x document root. */
export interface AsyncAPIDocument {
  asyncapi: string;
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
  security?: AsyncAPISecurityRequirement[];
}

export interface AsyncAPIChannel {
  address?: string;
  messages?: Record<string, AsyncAPIMessage>;
  description?: string;
}

export interface AsyncAPIOperation {
  action: "send" | "receive";
  channel?: AsyncAPIChannel;
  summary?: string;
  description?: string;
  messages?: AsyncAPIMessage[];
  reply?: AsyncAPIOperationReply;
  security?: AsyncAPISecurityRequirement[];
  tags?: AsyncAPITag[];
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
  payload?: Record<string, unknown>;
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

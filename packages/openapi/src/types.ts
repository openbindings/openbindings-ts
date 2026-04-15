/** Represents a parsed OpenAPI 3.x specification document. */
export interface OpenAPIDocument {
  openapi?: string;
  info?: {
    title?: string;
    version?: string;
    description?: string;
  };
  servers?: Array<{ url?: string; [key: string]: unknown }>;
  paths?: Record<string, OpenAPIPathItem>;
  [key: string]: unknown;
}

/** Represents a single path entry in an OpenAPI document, containing operations keyed by HTTP method. */
export interface OpenAPIPathItem {
  parameters?: OpenAPIParameter[];
  get?: OpenAPIOperation;
  put?: OpenAPIOperation;
  post?: OpenAPIOperation;
  delete?: OpenAPIOperation;
  options?: OpenAPIOperation;
  head?: OpenAPIOperation;
  patch?: OpenAPIOperation;
  trace?: OpenAPIOperation;
  [key: string]: unknown;
}

/** Represents an individual API operation (endpoint) within a path item. */
export interface OpenAPIOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  deprecated?: boolean;
  tags?: string[];
  parameters?: OpenAPIParameter[];
  requestBody?: OpenAPIRequestBody;
  responses?: Record<string, OpenAPIResponse>;
  [key: string]: unknown;
}

/** Represents a parameter (path, query, header, or cookie) for an API operation. */
export interface OpenAPIParameter {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Represents the request body definition for an API operation. */
export interface OpenAPIRequestBody {
  required?: boolean;
  content?: Record<string, OpenAPIMediaType>;
  [key: string]: unknown;
}

/** Represents a single response definition for an API operation. */
export interface OpenAPIResponse {
  description?: string;
  content?: Record<string, OpenAPIMediaType>;
  [key: string]: unknown;
}

/** Represents a media type entry (e.g. application/json) with its associated schema. */
export interface OpenAPIMediaType {
  schema?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Represents an OAuth2 flow object. */
export interface OpenAPIOAuthFlow {
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  scopes?: Record<string, string>;
  [key: string]: unknown;
}

/** Represents OAuth2 flows. */
export interface OpenAPIOAuthFlows {
  authorizationCode?: OpenAPIOAuthFlow;
  implicit?: OpenAPIOAuthFlow;
  clientCredentials?: OpenAPIOAuthFlow;
  password?: OpenAPIOAuthFlow;
  [key: string]: unknown;
}

/** Represents a security scheme definition from components.securitySchemes. */
export interface OpenAPISecurityScheme {
  type: string;
  description?: string;
  name?: string;
  in?: string;
  scheme?: string;
  bearerFormat?: string;
  flows?: OpenAPIOAuthFlows;
  openIdConnectUrl?: string;
  [key: string]: unknown;
}

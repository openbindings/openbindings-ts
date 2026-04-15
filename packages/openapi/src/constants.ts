/** Format token identifying this package as an OpenAPI 3.x handler. */
export const FORMAT_TOKEN = "openapi@^3.0.0";

/** Default source name used when registering an OpenAPI source in an OBInterface. */
export const DEFAULT_SOURCE_NAME = "openapi";

/** Set of valid HTTP methods recognized in OpenAPI path items. */
export const VALID_METHODS = new Set([
  "get", "post", "put", "patch", "delete", "head", "options", "trace",
]);

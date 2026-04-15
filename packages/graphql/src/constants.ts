/** Format token identifying this package as a GraphQL handler. */
export const FORMAT_TOKEN = "graphql";

/** Default source name used when registering a GraphQL source in an OBInterface. */
export const DEFAULT_SOURCE_NAME = "graphql";

/** Maximum depth for auto-generated selection sets. */
export const MAX_SELECTION_DEPTH = 3;

/**
 * Conventional input schema property name for a pre-built GraphQL query.
 * When the operation's input schema declares this property with a const value,
 * the executor uses it instead of building a query from introspection.
 */
export const QUERY_FIELD_NAME = "_query";

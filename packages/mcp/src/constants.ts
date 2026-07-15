/** The binding-specification identifier this package implements (exact and opaque, core §6). */
export const BINDING_SPEC = "openbindings.mcp@1";

/** Default source name used when registering an MCP source in an OBInterface. */
export const DEFAULT_SOURCE_NAME = "mcpServer";

/** Identity announced to MCP servers in the Client constructor. */
export const CLIENT_NAME = "openbindings-mcp";

/** Version reported to MCP servers; tracks @openbindings/mcp's package version. */
export const CLIENT_VERSION = "0.2.0";

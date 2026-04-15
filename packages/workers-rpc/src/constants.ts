/**
 * Format token identifying this package as a Cloudflare Workers RPC binding handler.
 *
 * Workers RPC bindings dispatch operation calls to a sibling Worker via a
 * Cloudflare service binding. The "transport" is `env[bindingName][methodName](args)`
 * with structured-clone serialization handled by the Cloudflare runtime — there
 * is no HTTP, no JSON, no URL.
 *
 * The binding ref is just the method name on the WorkerEntrypoint class. There
 * is no path encoding, no HTTP method, no headers. The OBI binding entry's
 * `source` field points at a workers-rpc source declaration; the `ref` field
 * is the literal method name to invoke.
 *
 * Versioning: 1.0 because the Cloudflare Workers RPC contract has been stable
 * since the WorkerEntrypoint API became GA. Future revisions would bump the
 * minor when adding capabilities (streaming, durable-object support, etc.).
 */
export const FORMAT_TOKEN = "workers-rpc@^1.0.0";

/** Default source name when registering a workers-rpc source in an OBInterface. */
export const DEFAULT_SOURCE_NAME = "workersRpc";

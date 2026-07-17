export { AsyncAPIInvoker, AsyncAPISynthesizer } from "./invoker.js";
export { BINDING_SPEC, DEFAULT_SOURCE_NAME } from "./constants.js";
// Connection pooling (WSPool/PooledWS) is a binding-specification-library
// implementation concern, not part of the binding-invoker contract, so it is
// not part of this package's public API. It stays internal to the module,
// matching Go's unexported asyncapi pool.

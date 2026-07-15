/**
 * @openbindings/workers-rpc
 *
 * Cloudflare Workers RPC binding invoker for OpenBindings.
 *
 * Use {@link WorkersRpcInvoker} to dispatch operation calls from a Worker
 * to a sibling Worker exposing a `WorkerEntrypoint` class via a service
 * binding declared in `wrangler.toml`.
 *
 * The invoker implements the standard `BindingInvoker` interface from
 * `@openbindings/sdk` and slots into any OB codegen typed invoker. The
 * typed invoker is generated from an OBI document whose source declares
 * `bindingSpec: "workers-rpc@^1.0.0"` and whose binding entries' `ref`
 * field is the method name on the WorkerEntrypoint class.
 *
 * Example OBI source declaration:
 *
 * ```json
 * {
 *   "sources": {
 *     "myService": {
 *       "bindingSpec": "workers-rpc@^1.0.0",
 *       "location": "workers-rpc://my-service"
 *     }
 *   },
 *   "bindings": {
 *     "someMethod.myService": {
 *       "operation": "someMethod",
 *       "source": "myService",
 *       "ref": "someMethod"
 *     }
 *   }
 * }
 * ```
 */

export { WorkersRpcInvoker } from "./invoker.js";
export type { WorkersRpcBinding, WorkersRpcInvokerOptions } from "./invoker.js";
export { BINDING_SPEC, DEFAULT_SOURCE_NAME } from "./constants.js";

// Compatibility module for existing source imports inside this package.
// Invocation and synthesis are separate roles: invocation is a thin protocol
// adapter over the standalone client, while synthesis projects analysis into
// OpenBindings contracts.
export { OpenAPIInvoker } from "./native-invoker.js";
export type { OpenAPIInvokerOptions } from "./native-invoker.js";
export { OpenAPISynthesizer } from "./synthesizer.js";

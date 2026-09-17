/** Internal entry for @openbindings/jsonata. Unsupported outside the project:
 * no compatibility promise, no five-line contract. Reached by the deep path
 * `@openbindings/json/internal`. Everything here is module-private to this
 * installation; a second installation has its own registry. */
export { authenticate, authenticateGraph, isAuthenticated } from "./authenticate.js";
export { admit } from "./codec.js";
export { admitNumber, forceEncoded as force, equalEncoded, codePointCount, isNumberToken } from "./leaves.js";
export { isForcingReason } from "./counters.js";
export { accounting, unaccounted } from "./counters.js";

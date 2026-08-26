export * from "@openbindings/openapi-client/analysis";

import {
  planRequestBodies as planRequestBodiesFromClient,
} from "@openbindings/openapi-client/analysis";
import { withEngineEncodingAdmissionView } from "./parameter-semantics.js";

/** Routes §8 Encoding/style admission through the binding's §5.2 resolver. */
export function planRequestBodies(
  ...args: Parameters<typeof planRequestBodiesFromClient>
): ReturnType<typeof planRequestBodiesFromClient> {
  const [operation, options] = args;
  return withEngineEncodingAdmissionView(
    operation,
    options?.openapiVersion,
    () => planRequestBodiesFromClient(...args),
  );
}

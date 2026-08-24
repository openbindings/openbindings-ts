export {
  checkInterfaceCompatibility,
  checkOperationCompatibility,
} from "./compatibility.js";
export type { CompatibilityIssue } from "./compatibility.js";

export { Normalizer, inputCompatible, outputCompatible } from "./schema-profile/index.js";
export type { Fetcher, JSONValue, JSONObject, CompatResult } from "./schema-profile/index.js";
export {
  NotNormalizedError,
  OutsideProfileError,
  SelectorError,
  SchemaError,
} from "./schema-profile/index.js";

export type {
  JSONSchema,
  Satisfies,
  OperationExample,
  Operation,
  Source,
  Transform,
  TransformOrRef,
  TransformRef,
  BindingEntry,
  SecurityMethod,
  OBInterface,
} from "./types.js";
export { isTransformRef, resolveTransform } from "./types.js";

export type {
  InvocationSource,
  BindingInvocationInput,
  OperationInvocationInput,
  InvocationOutput,
  CreateSource,
  CreateInput,
  InvocationError,
  FormatInfo,
  BindableTarget,
  SourceInspection,
} from "./invoker-types.js";

export type {
  ContextStore,
  PlatformCallbacks,
  BrowserRedirectResult,
  PromptOptions,
  FileSelectOptions,
} from "./context.js";
export {
  contextBearerToken,
  contextApiKey,
  contextBasicAuth,
  contextString,
  contextHeaders,
  contextCookies,
  contextEnvironment,
  contextMetadata,
  redactContext,
  normalizeContextKey,
  normalizeEndpoint,
  buildAuthHeaders,
  MemoryStore,
  ContextInsufficientError,
  ResolutionUnavailableError,
} from "./context.js";

export type {
  BindingInvoker,
  InterfaceCreator,
  SourceInspector,
  TransformEvaluator,
  TransformEvaluatorWithBindings,
  BindingSelector,
} from "./invokers.js";
export { isInterfaceCreator, isTransformEvaluatorWithBindings } from "./invokers.js";

export {
  OperationInvoker,
  defaultBindingSelector,
} from "./operation-invoker.js";
export type { OperationInvokerOptions } from "./operation-invoker.js";

export { combineInvokers, combineCreators, combineSourceInspectors, type CombinedInvoker } from "./combiners.js";

export { validateInterface } from "./validate.js";
export type { ValidateOptions } from "./validate.js";
export { parseDocument, validateDocument, formatValidationErrors } from "./parse.js";

export type { ValidationFailure } from "./schema-validation.js";

export {
  NoInvokerError,
  NoCreatorError,
  OperationNotFoundError,
  BindingNotFoundError,
  MissingInterfaceError,
  UnknownSourceError,
  NoTransformEvaluatorError,
  NoSourcesError,
  TransformRefNotFoundError,
  EmptyTransformExpressionError,
  ValidationError,
} from "./errors.js";

export {
  MIN_SUPPORTED_VERSION,
  MAX_TESTED_VERSION,
  supportedRange,
  isSupportedVersion,
  isValidSemver,
  isHigherMajorOrPre1MinorThanMaxTested,
} from "./version.js";

export type { FormatToken, VersionRange, RangeKind } from "./format-token.js";
export {
  parseFormatToken,
  isFormatToken,
  normalizeFormatToken,
  formatTokenToString,
  isValidFormatName,
  isOpenBindingsToken,
  parseRange,
  matchesRange,
} from "./format-token.js";

export { canonicalize } from "./canonical-json.js";

export { canonicalizeLocation, resolveRef, unknownFields } from "./uri.js";

export { fetchInterface, MEDIA_TYPE, WELL_KNOWN_PATH } from "./fetch.js";
export type { FetchInterfaceOptions, FetchedInterface } from "./fetch.js";

export { checkInterfaceCompatibility, isOBInterface } from "./compatibility.js";
export type { CompatibilityIssue, CheckCompatibilityOptions } from "./compatibility.js";

export { formatName, maybeJSON, detectFormatVersion, isHttpUrl } from "./helpers.js";

export {
  ERR_AUTH_REQUIRED,
  ERR_PERMISSION_DENIED,
  ERR_INVALID_REF,
  ERR_REF_NOT_FOUND,
  ERR_INVALID_INPUT,
  ERR_SOURCE_LOAD_FAILED,
  ERR_SOURCE_CONFIG_ERROR,
  ERR_CONNECT_FAILED,
  ERR_EXECUTION_FAILED,
  ERR_RESPONSE_ERROR,
  ERR_STREAM_ERROR,
  ERR_TIMEOUT,
  ERR_CANCELLED,
  ERR_BINDING_NOT_FOUND,
  ERR_TRANSFORM_ERROR,
  ERR_VALIDATION_FAILED,
  httpErrorCode,
} from "./errcodes.js";

export { resolveSecurity, AuthCancelledError } from "./security.js";

export { dereference } from "./deref.js";

export { Normalizer, inputCompatible, outputCompatible } from "./schema-profile/index.js";
export type { Fetcher, JSONValue, JSONObject, CompatResult } from "./schema-profile/index.js";
export {
  OutsideProfileError,
  RefError,
  SchemaError,
} from "./schema-profile/index.js";

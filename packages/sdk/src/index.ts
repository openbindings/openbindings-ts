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
  ExecuteSource,
  BindingExecutionInput,
  OperationExecutionInput,
  ExecuteOutput,
  CreateSource,
  CreateInput,
  ExecutionOptions,
  StreamEvent,
  ExecuteError,
  FormatInfo,
  BindableRef,
  ListRefsResult,
} from "./executor-types.js";

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
  redactContext,
  normalizeContextKey,
  MemoryStore,
  ContextInsufficientError,
  ResolutionUnavailableError,
} from "./context.js";

export type {
  BindingExecutor,
  InterfaceCreator,
  TransformEvaluator,
  TransformEvaluatorWithBindings,
  BindingSelector,
} from "./executors.js";
export { isInterfaceCreator, isTransformEvaluatorWithBindings } from "./executors.js";

export {
  OperationExecutor,
  defaultBindingSelector,
} from "./executor.js";
export type { OperationExecutorOptions } from "./executor.js";

export { combineExecutors, combineCreators, type CombinedExecutor } from "./combiners.js";

export { validateInterface } from "./validate.js";
export type { ValidateOptions } from "./validate.js";

export {
  NoExecutorError,
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

export { InterfaceClient } from "./interface-client.js";
export type {
  OperationEntry,
  InterfaceClientState,
  InterfaceClientOptions,
} from "./interface-client.js";

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
  httpErrorCode,
} from "./errcodes.js";

export { resolveSecurity } from "./security.js";

export { dereference } from "./deref.js";

export { Normalizer, inputCompatible, outputCompatible } from "./schema-profile/index.js";
export type { Fetcher, JSONValue, JSONObject, CompatResult } from "./schema-profile/index.js";
export {
  OutsideProfileError,
  RefError,
  SchemaError,
} from "./schema-profile/index.js";

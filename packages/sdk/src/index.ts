export type {
  JSONSchema,
  OperationExample,
  Operation,
  Source,
  Transform,
  TransformOrRef,
  TransformRef,
  BindingEntry,
  OBInterface,
} from "./types.js";
export { isTransformRef, resolveTransform } from "./types.js";

export type {
  Invocation,
  BindingHandle,
  Metadata,
  ContextRequirement,
  ContextAlternative,
  ContextRequiredDetails,
  InvocationImplOptions,
} from "./invocation.js";
export {
  InvocationError,
  InvocationImpl,
  single,
  contextRequiredError,
  isContextRequired,
} from "./invocation.js";

export type {
  InvocationSource,
  BindingInvocationArgs,
  InvokeOptions,
  SynthesizeSource,
  SynthesizeInput,
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
  contextSatisfies,
  scopeContext,
  storeContextResolver,
} from "./context.js";

export type {
  BindingInvoker,
  InterfaceSynthesizer,
  SourceInspector,
  TransformEvaluator,
  TransformEvaluatorWithBindings,
  BindingSelector,
  ContextResolver,
} from "./invokers.js";
export { isInterfaceSynthesizer, isTransformEvaluatorWithBindings } from "./invokers.js";

export {
  OperationInvoker,
  defaultBindingSelector,
} from "./operation-invoker.js";
export type { OperationInvokerOptions } from "./operation-invoker.js";

export { operationSignature } from "./operation-signature.js";
export type { OperationSignature } from "./operation-signature.js";

export { combineInvokers, combineSynthesizers, combineSourceInspectors, type CombinedInvoker } from "./combiners.js";

export { validateInterface } from "./validate.js";
export type { ValidateOptions } from "./validate.js";
export { parseDocument, validateDocument, formatValidationErrors } from "./parse.js";

export type { ValidationFailure } from "./schema-validation.js";

export {
  NoInvokerError,
  NoSynthesizerError,
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
  isUnsupportedPrerelease,
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
export type { CompatibilityIssue } from "./compatibility.js";

export { resolveOperation, allOperationIdentifiers } from "./resolve-operation.js";
export type { ResolvedOperation } from "./resolve-operation.js";

export { formatName, isJSONContentType, detectFormatVersion, isHttpUrl } from "./helpers.js";

export {
  InvokeHooks,
  USE_DEFAULT,
  assumptionWarning,
  classifyThroughHooks,
  decodeThroughHooks,
  floorStamped,
  newInvokeHooks,
  nonDiscriminatingOutput,
  siteFormatName,
} from "./hooks.js";
export type {
  BindingPlan,
  FieldRouter,
  HookSlots,
  InvocationPlan,
  InvokeSite,
  OutputDecoder,
  PlanAxis,
  RawResult,
  ResultClassifier,
} from "./hooks.js";

export {
  CONTEXT_REQUIRED,
  ERR_ALREADY_CONSUMED,
  ERR_AUTH_REQUIRED,
  ERR_BINDING_NOT_FOUND,
  ERR_CANCELLED,
  ERR_CONNECT_FAILED,
  ERR_EVENT_LIMIT_EXCEEDED,
  ERR_EXECUTION_FAILED,
  ERR_EXPECTED_SINGLE,
  ERR_INPUT_CLOSED,
  ERR_INVALID_REF,
  ERR_INVOCATION_CLOSED,
  ERR_UNSUPPORTED_FORMAT_VERSION,
  ERR_MISSING_INPUT,
  ERR_OPERATION_GRAPH_EXIT,
  ERR_OPERATION_NOT_FOUND,
  ERR_PERMISSION_DENIED,
  ERR_PROTOCOL,
  ERR_REF_NOT_FOUND,
  ERR_RESPONSE_ERROR,
  ERR_RUNTIME,
  ERR_SOURCE_CONFIG_ERROR,
  ERR_SOURCE_LOAD_FAILED,
  ERR_STREAM_ERROR,
  ERR_TIMEOUT,
  ERR_TOO_MANY_INPUTS,
  ERR_TRANSFORM_ERROR,
  ERR_TRANSPORT_CLOSED,
  ERR_UNKNOWN_SOURCE,
  ERR_VALIDATION_FAILED,
  httpErrorCode,
} from "./errcodes.js";

export { dereference } from "./deref.js";

export { Normalizer, inputCompatible, outputCompatible } from "./schema-profile/index.js";
export type { Fetcher, JSONValue, JSONObject, CompatResult } from "./schema-profile/index.js";
export {
  OutsideProfileError,
  RefError,
  SchemaError,
} from "./schema-profile/index.js";

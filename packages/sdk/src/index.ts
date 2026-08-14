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
export { isTransformRef, resolveTransform, schemaObjectForm } from "./types.js";

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
  isContextRequiredDetails,
  isPortableInvocationData,
  configValueRequirement,
  isContextRequired,
} from "./invocation.js";

export type {
  InvocationSource,
  BindingInvocationArgs,
  InvokeOptions,
  SynthesizeSource,
  SynthesizeInput,
  SynthesizerWarning,
  SynthesisCoverageScope,
  SynthesisCoverageStatus,
  SynthesisCoverageEntry,
  SynthesisCoverage,
  SynthesisCoverageLimitation,
  SynthesizeResult,
  BindingSpecInfo,
  BindableTarget,
  SourceInspection,
  InspectionLimitation,
} from "./invoker-types.js";
export {
  DEFAULT_MAX_DELIVERY_UNIT_BYTES,
  resolveDeliveryUnitLimit,
  synthesisSkeleton,
  finalizeSynthesis,
  finalizeSynthesisCoverage,
  representedCoverageEntries,
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
  contextBearerTokenFor,
  contextNamedCredential,
  contextApiKey,
  contextApiKeyFor,
  contextBasicAuth,
  contextBasicAuthFor,
  contextAccessTokenFor,
  contextString,
  contextHeaders,
  contextCookies,
  contextEnvironment,
  contextConfiguration,
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
  CoverageSynthesizer,
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

export {
  operationRequirement,
  matchOperationRequirement,
  resolveOperationRequirement,
} from "./operation-requirement.js";
export type {
  OperationRequirement,
  OperationImplementation,
  OperationImplementationAssessment,
  OperationRequirementMatchOptions,
  OperationMatch,
  OperationRequirementMatches,
  OperationRequirementResolution,
} from "./operation-requirement.js";

export {
  combineInvokers,
  combineSynthesizers,
  combineSourceInspectors,
  type CombinedInvoker,
  type CombinedSynthesizer,
} from "./combiners.js";

export { validateInterface } from "./validate.js";
export type { ValidateOptions } from "./validate.js";
export { parseDocument, validateDocument, formatValidationErrors } from "./parse.js";

export type { ValidationFailure } from "./schema-validation.js";
export { compileEmbeddedSchema, compileExampleSchema, compileOperationSchema, type CompiledSchema } from "./schema-validation.js";

export {
  NoInvokerError,
  NoSynthesizerError,
  SynthesisCoverageUnsupportedError,
  OperationNotFoundError,
  BindingNotFoundError,
  BindingSelectionRequiredError,
  MissingInterfaceError,
  UnknownSourceError,
  NoTransformEvaluatorError,
  NoSourcesError,
  MultipleSourcesError,
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
  isLowerThanMinSupported,
  isUnsupportedPrerelease,
} from "./version.js";

export { canonicalize } from "./canonical-json.js";

export { canonicalizeLocation, resolveRef, unknownFields } from "./uri.js";

export { fetchInterface, MEDIA_TYPE, WELL_KNOWN_PATH } from "./fetch.js";
export type { FetchInterfaceOptions, FetchedInterface } from "./fetch.js";

export {
  checkInterfaceCompatibility,
  checkOperationCompatibility,
  isOBInterface,
} from "./compatibility.js";
export type { CompatibilityIssue } from "./compatibility.js";

export { resolveOperation, allOperationIdentifiers } from "./resolve-operation.js";
export type { ResolvedOperation } from "./resolve-operation.js";

export { concludeVerification } from "./verification.js";
export type {
  RuleEvidenceStatus,
  VerificationConclusion,
  VerificationReport,
} from "./verification.js";

export { familyName, isJSONContentType, isHttpUrl } from "./helpers.js";

export {
  InvokeHooks,
  USE_DEFAULT,
  assumptionWarning,
  classifyThroughHooks,
  decodeThroughHooks,
  floorStamped,
  newInvokeHooks,
  nonDiscriminatingOutput,
  siteFamilyName,
} from "./hooks.js";
export type {
  FieldRouter,
  HookSlots,
  InvokeSite,
  OutputDecoder,
  RawResult,
  ResultClassifier,
} from "./hooks.js";

export {
  CONTEXT_REQUIRED,
  ERR_ALREADY_CONSUMED,
  ERR_BINDING_NOT_FOUND,
  ERR_BINDING_SELECTION_REQUIRED,
  ERR_CANCELLED,
  ERR_CONNECT_FAILED,
  ERR_EVENT_LIMIT_EXCEEDED,
  ERR_EXECUTION_FAILED,
  ERR_EXPECTED_SINGLE,
  ERR_FRAME_PROTOCOL,
  ERR_INPUT_CLOSED,
  ERR_INVALID_REF,
  ERR_INVOCATION_CLOSED,
  ERR_UNSUPPORTED_FORMAT_VERSION,
  ERR_MISSING_INPUT,
  ERR_OPERATION_GRAPH_EXIT,
  ERR_OPERATION_NOT_FOUND,
  ERR_OPERATION_VALIDATION_FAILED,
  ERR_PROTOCOL,
  ERR_REF_NOT_FOUND,
  ERR_RESPONSE_ERROR,
  ERR_RUNTIME,
  ERR_REFUSED,
  ERR_SOURCE_CONFIG_ERROR,
  ERR_SOURCE_LOAD_FAILED,
  ERR_STREAM_ERROR,
  ERR_TIMEOUT,
  ERR_TOO_MANY_INPUTS,
  ERR_TRANSFORM_ERROR,
  ERR_TRANSPORT_CLOSED,
  ERR_UNKNOWN_SOURCE,
  ERR_SCHEMA_UNRESOLVED,
  ERR_TYPE_MISMATCH,
  ERR_VALIDATION_FAILED,
} from "./errcodes.js";
export type { InvocationErrorCode } from "./errcodes.js";

export { dereference } from "./deref.js";

export { matchProcessorObservation } from "./processor-scenarios.js";
export type {
  ProcessorScenarioFile,
  ProcessorScenario,
  ProcessorExpected,
  ProcessorAssertion,
  ProcessorDisposition,
  ProcessorPhase,
  ProcessorObservation,
  ProcessorMatch,
} from "./processor-scenarios.js";

export {
  matchSynthesisScenario,
  normalizeSynthesis,
  verifySynthesisScenario,
} from "./synthesis-scenarios.js";
export type {
  RefusedScenarioExpected,
  SynthesisScenarioFile,
  SynthesisScenario,
  SynthesisScenarioExpected,
  SynthesizedScenarioExpected,
  NormalizedSynthesis,
  SynthesisBindingIdentity,
  NormalizedSynthesisCoverageEntry,
} from "./synthesis-scenarios.js";

export { Normalizer, inputCompatible, outputCompatible } from "./schema-profile/index.js";
export type { Fetcher, JSONValue, JSONObject, CompatResult } from "./schema-profile/index.js";
export {
  NotNormalizedError,
  OutsideProfileError,
  RefError,
  SchemaError,
} from "./schema-profile/index.js";

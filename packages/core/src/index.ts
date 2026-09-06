export type {
  JSONSchema,
  OperationExample,
  Operation,
  Source,
  Transform,
  TransformOrRef,
  TransformRef,
  BindingEntry,
  DependencyEntry,
  OBInterface,
} from "./types.js";
export { isTransformRef, resolveTransform, schemaObjectForm } from "./types.js";

export { validateInterface } from "./validate.js";
export type { ValidateOptions } from "./validate.js";
export { parseDocument, validateDocument, formatValidationErrors, isOBInterface } from "./parse.js";

export type { ValidationFailure } from "./schema-validation.js";
export {
  compileEmbeddedSchema,
  compileExampleSchema,
  compileOperationSchema,
  safeValidate,
  type CompiledSchema,
} from "./schema-validation.js";

export { DependencyNotFoundError, OperationNotFoundError, ValidationError } from "./errors.js";

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

export { resolveOperation, allOperationIdentifiers } from "./resolve-operation.js";
export type { ResolvedOperation } from "./resolve-operation.js";

export { lookupDependency } from "./lookup-dependency.js";
export type { ResolvedDependency } from "./lookup-dependency.js";

export { PreparedInterface, prepareInterface } from "./prepared-interface.js";
export type {
  OperationSchemaPosition,
  PrepareInterfaceOptions,
  PreparedBindingDescriptor,
  PreparedBoundaryContract,
  PreparedDependencyDescriptor,
  PreparedOperationDescriptor,
} from "./prepared-interface.js";

export { concludeVerification } from "./verification.js";
export type {
  RuleEvidenceStatus,
  VerificationConclusion,
  VerificationReport,
} from "./verification.js";

export { isHttpUrl } from "./helpers.js";

export { checkBindingSpecs } from "./bindingspec.js";
export type { BindingSpecInfo, BindingSpecVerdict } from "./bindingspec.js";

export { MEDIA_TYPE, WELL_KNOWN_PATH } from "./constants.js";

export { dereference } from "./deref.js";

export { checkAssertions, matchProcessorObservation } from "./processor-scenarios.js";
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

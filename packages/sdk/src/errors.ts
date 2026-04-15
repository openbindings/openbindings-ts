/** Thrown when no executor matches the requested binding format. */
export class NoExecutorError extends Error {
  constructor(format: string) {
    super(`openbindings: no executor for format: ${format}`);
    this.name = "NoExecutorError";
  }
}

/** Thrown when no creator matches the requested binding format. */
export class NoCreatorError extends Error {
  constructor(format: string) {
    super(`openbindings: no creator for format: ${format}`);
    this.name = "NoCreatorError";
  }
}

/** Thrown when the requested operation does not exist in the interface. */
export class OperationNotFoundError extends Error {
  constructor(operation: string) {
    super(`openbindings: operation not found: ${operation}`);
    this.name = "OperationNotFoundError";
  }
}

/** Thrown when no binding is available for the requested operation. */
export class BindingNotFoundError extends Error {
  constructor(operation: string) {
    super(`openbindings: no binding for operation: ${operation}`);
    this.name = "BindingNotFoundError";
  }
}

/** Thrown when a nil/undefined interface is passed to an operation that requires one. */
export class MissingInterfaceError extends Error {
  constructor() {
    super("openbindings: interface is required");
    this.name = "MissingInterfaceError";
  }
}

/** Thrown when a binding references a source not present in the interface. */
export class UnknownSourceError extends Error {
  constructor(bindingKey: string, sourceKey: string) {
    super(
      `openbindings: unknown source: binding "${bindingKey}" references "${sourceKey}"`,
    );
    this.name = "UnknownSourceError";
  }
}

/** Thrown when a binding has a transform but no evaluator is configured. */
export class NoTransformEvaluatorError extends Error {
  constructor(bindingKey: string) {
    super(
      `openbindings: transform evaluator required but not configured: binding "${bindingKey}"`,
    );
    this.name = "NoTransformEvaluatorError";
  }
}

/** Thrown when an operation requires sources but none were provided. */
export class NoSourcesError extends Error {
  constructor() {
    super("openbindings: no sources provided");
    this.name = "NoSourcesError";
  }
}

/** Thrown when a transform `$ref` reference cannot be resolved. */
export class TransformRefNotFoundError extends Error {
  constructor(ref: string) {
    super(`openbindings: transform reference not found: ${ref}`);
    this.name = "TransformRefNotFoundError";
  }
}

/** Thrown when a transform has no expression to evaluate. */
export class EmptyTransformExpressionError extends Error {
  constructor() {
    super("openbindings: transform expression is empty");
    this.name = "EmptyTransformExpressionError";
  }
}

/** Thrown when an interface fails structural validation, carrying the list of problems found. */
export class ValidationError extends Error {
  problems: string[];

  constructor(problems: string[]) {
    super(
      problems.length > 0
        ? `invalid interface: ${problems.join("; ")}`
        : "invalid interface",
    );
    this.name = "ValidationError";
    this.problems = problems;
  }
}

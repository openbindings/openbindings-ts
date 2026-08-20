/** Thrown when no invoker matches the requested binding specification. */
export class NoInvokerError extends Error {
  constructor(bindingSpec: string) {
    super(`openbindings: no invoker for format: ${bindingSpec}`);
    this.name = "NoInvokerError";
  }
}

/**
 * Thrown when no binding is available for the requested operation. When the
 * operation HAS a binding but its governing binding specification has no
 * registered invoker, `detail` names the gap (which binding spec, what is
 * registered) so the reader is sent to their own OperationInvoker
 * construction rather than to auditing the OBI.
 */
export class BindingNotFoundError extends Error {
  constructor(operation: string, detail?: string) {
    super(
      `openbindings: no binding for operation: ${operation}${detail ? ` — ${detail}` : ""}`,
    );
    this.name = "BindingNotFoundError";
  }
}

/** Thrown when several invocable bindings remain and the caller must choose. */
export class BindingSelectionRequiredError extends Error {
  constructor(operation: string, count: number) {
    super(
      `openbindings: binding selection required: operation ${JSON.stringify(operation)} has ${count} invocable bindings; choose one with bindingKey or context.configuration.selection`,
    );
    this.name = "BindingSelectionRequiredError";
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

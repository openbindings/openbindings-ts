/** Thrown when no invoker matches the requested binding format. */
export class NoInvokerError extends Error {
  constructor(format: string) {
    super(`openbindings: no invoker for format: ${format}`);
    this.name = "NoInvokerError";
  }
}

/** Thrown when no synthesizer matches the requested binding format. */
export class NoSynthesizerError extends Error {
  constructor(format: string) {
    super(`openbindings: no synthesizer for format: ${format}`);
    this.name = "NoSynthesizerError";
  }
}

/** Thrown when the requested operation does not exist in the interface. */
export class OperationNotFoundError extends Error {
  constructor(operation: string, searched?: string[]) {
    const detail =
      searched && searched.length > 0
        ? `; searched operation identifiers (keys and aliases): [${searched.join(", ")}]`
        : "";
    super(`openbindings: operation not found: ${operation}${detail}`);
    this.name = "OperationNotFoundError";
  }
}

/**
 * Thrown when no binding is available for the requested operation. When the
 * operation HAS a binding but its source format has no registered invoker,
 * `detail` names the gap (which format, what is registered) so the reader is
 * sent to their own OperationInvoker construction rather than to auditing the
 * OBI.
 */
export class BindingNotFoundError extends Error {
  constructor(operation: string, detail?: string) {
    super(
      `openbindings: no binding for operation: ${operation}${detail ? ` — ${detail}` : ""}`,
    );
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

/** Thrown by single-source synthesizers handed a multi-source input.
 * Multi-source composition is implementation-defined; answering for a
 * subset silently is never legitimate — synthesize per source and merge,
 * or use a multi-source synthesizer. */
export class MultipleSourcesError extends Error {
  constructor() {
    super("openbindings: this synthesizer composes one source per call; synthesize per source and merge, or use a multi-source synthesizer");
    this.name = "MultipleSourcesError";
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

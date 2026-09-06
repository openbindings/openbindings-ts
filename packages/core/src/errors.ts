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

/** Thrown when a named dependency is absent or cannot resolve its local operation. */
export class DependencyNotFoundError extends Error {
  constructor(dependency: string, available?: string[]) {
    const detail =
      available && available.length > 0
        ? `; available dependency keys: [${available.join(", ")}]`
        : "";
    super(`openbindings: dependency not found or invalid: ${dependency}${detail}`);
    this.name = "DependencyNotFoundError";
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

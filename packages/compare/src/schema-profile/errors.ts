export class OutsideProfileError extends Error {
  path: string;
  keyword: string;

  constructor(path: string, keyword: string) {
    const loc = path || "<root>";
    super(
      path
        ? `outside profile at ${loc}: keyword "${keyword}"`
        : `outside profile: keyword "${keyword}"`,
    );
    this.name = "OutsideProfileError";
    this.path = path;
    this.keyword = keyword;
  }
}

/**
 * Indicates a schema handed to a free directional check (inputCompatible /
 * outputCompatible) was not pre-normalized: the check found a shape the
 * Normalizer never emits. `path` names the offending location ("target" or
 * "candidate", then the nested path), `keyword` the offending keyword, and
 * `requirement` the normalization invariant it violates. The message is
 * byte-identical with the Go SDK's NotNormalizedError.
 */
export class NotNormalizedError extends Error {
  path: string;
  keyword: string;
  requirement: string;

  constructor(path: string, keyword: string, requirement: string) {
    super(`not normalized at ${path}: keyword "${keyword}" must be ${requirement}`);
    this.name = "NotNormalizedError";
    this.path = path;
    this.keyword = keyword;
    this.requirement = requirement;
  }
}

export class SelectorError extends Error {
  path: string;
  ref: string;

  constructor(path: string, ref: string, cause: Error | string) {
    const loc = path || "<root>";
    const msg = typeof cause === "string" ? cause : cause.message;
    super(
      path ? `${loc}.$ref "${ref}": ${msg}` : `$ref "${ref}": ${msg}`,
      cause instanceof Error ? { cause } : undefined,
    );
    this.name = "SelectorError";
    this.path = path;
    this.ref = ref;
  }
}

export class SchemaError extends Error {
  path: string;

  constructor(path: string, message: string) {
    const loc = path || "<root>";
    super(
      path
        ? `schema error at ${loc}: ${message}`
        : `schema error: ${message}`,
    );
    this.name = "SchemaError";
    this.path = path;
  }
}

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

export class RefError extends Error {
  path: string;
  ref: string;

  constructor(path: string, ref: string, cause: Error | string) {
    const loc = path || "<root>";
    const msg = typeof cause === "string" ? cause : cause.message;
    super(
      path ? `${loc}.$ref "${ref}": ${msg}` : `$ref "${ref}": ${msg}`,
      cause instanceof Error ? { cause } : undefined,
    );
    this.name = "RefError";
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

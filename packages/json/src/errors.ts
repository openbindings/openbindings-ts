/** The one error class this package throws. `code` is stable; `message` is not. */
export type ValueErrorCode =
  | "ERR_JSON_SYNTAX"
  | "ERR_JSON_ADMISSION"
  | "ERR_JSON_BUDGET"
  | "ERR_JSON_INEXACT"
  | "ERR_JSON_COERCION"
  | "ERR_JSON_POINTER"
  | "ERR_JSON_DISPOSED_SESSION";

export interface ValueErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/** Every value or budget failure in this package is a ValueError. `details` may
 * carry `limit`, `actual`, `path` (a JSON Pointer to the offending member) or
 * `reason`. `cause` carries an adapter's own error when one was thrown. The
 * offending value is never retained. */
export class ValueError extends Error {
  declare readonly name: "ValueError";
  declare readonly cause?: unknown;
  readonly code: ValueErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;
  constructor(code: ValueErrorCode, message: string, options?: ValueErrorOptions) {
    super(message, options && "cause" in options ? { cause: options.cause } : undefined);
    this.code = code;
    if (options?.details) this.details = Object.freeze({ ...options.details });
  }
}
Object.defineProperty(ValueError.prototype, "name", { value: "ValueError", writable: true, configurable: true });

/** Escape one reference token per RFC 6901 section 3. */
export function pointer(segments: readonly string[]): string {
  let out = "";
  for (const segment of segments) out += "/" + segment.replace(/~/g, "~0").replace(/\//g, "~1");
  return out;
}

export function admission(message: string, path?: readonly string[], cause?: unknown): ValueError {
  const details = path && path.length ? { path: pointer(path) } : undefined;
  return new ValueError("ERR_JSON_ADMISSION", message, cause === undefined ? { details } : { details, cause });
}

export function budget(message: string, limit: number, actual: number): ValueError {
  return new ValueError("ERR_JSON_BUDGET", message, { details: { limit, actual } });
}

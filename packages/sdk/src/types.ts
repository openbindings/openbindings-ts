/**
 * Intentionally untyped JSON Schema representation.
 * Avoids coupling to any one JSON Schema library while preserving
 * arbitrary keys/values structurally.
 */
export type JSONSchema = Record<string, unknown>;

/** Maps a local operation to an operation in another interface via a role. */
export interface Satisfies {
  role: string;
  operation: string;
  [key: string]: unknown;
}

/** An example input/output pair for an operation. */
export interface OperationExample {
  description?: string;
  input?: unknown;
  output?: unknown;
  [key: string]: unknown;
}

/** Defines an operation in the OpenBindings interface, including its input/output schemas and metadata. */
export interface Operation {
  description?: string;
  deprecated?: boolean;
  tags?: string[];
  aliases?: string[];
  satisfies?: Satisfies[];

  idempotent?: boolean;
  input?: JSONSchema;
  output?: JSONSchema;

  examples?: Record<string, OperationExample>;
  [key: string]: unknown;
}

/** Describes a binding source, identifying the format and where to find the API definition. */
export interface Source {
  format: string;
  location?: string;
  content?: unknown;
  description?: string;
  /** Default priority for bindings referencing this source. Binding-level priority overrides. Lower wins. */
  priority?: number;
  [key: string]: unknown;
}

/** A JSON-to-JSON transformation. For v0.1, type must be "jsonata". */
export interface Transform {
  type: string;
  expression: string;
  [key: string]: unknown;
}

/**
 * Either an inline transform or a `$ref` to a named transform.
 * Use {@link isTransformRef} to determine which form is present.
 */
export interface TransformOrRef {
  $ref?: string;
  type?: string;
  expression?: string;
  [key: string]: unknown;
}

/** A {@link TransformOrRef} that is known to be a `$ref` reference. */
export interface TransformRef extends TransformOrRef {
  $ref: string;
}

/**
 * A security method declaration, discriminated on the `type` field.
 * Well-known types: "bearer", "oauth2", "basic", "apiKey".
 * Unknown types SHOULD be skipped by clients.
 */
export interface SecurityMethod {
  type: string;
  description?: string;
  /** OAuth2 authorization endpoint URL (required for type "oauth2"). */
  authorizeUrl?: string;
  /** OAuth2 token endpoint URL (required for type "oauth2"). */
  tokenUrl?: string;
  /** Available OAuth2 scopes. */
  scopes?: string[];
  /** For type "oauth2": optional client identifier. Servers MAY use a default. */
  clientId?: string;
  /** For type "apiKey": the name of the header, query parameter, or cookie. */
  name?: string;
  /** For type "apiKey": where the key is sent ("header", "query", or "cookie"). */
  in?: "header" | "query" | "cookie";
  [key: string]: unknown;
}

/** Maps an operation to a concrete source with optional input/output transforms. */
export interface BindingEntry {
  operation: string;
  source: string;
  ref?: string;
  priority?: number;
  description?: string;
  deprecated?: boolean;
  /** Key referencing an entry in the document's security map. */
  security?: string;
  inputTransform?: TransformOrRef;
  outputTransform?: TransformOrRef;
  [key: string]: unknown;
}

/** The top-level OpenBindings interface document. */
export interface OBInterface {
  openbindings: string;
  name?: string;
  version?: string;
  description?: string;
  schemas?: Record<string, JSONSchema>;
  operations: Record<string, Operation>;
  roles?: Record<string, string>;
  sources?: Record<string, Source>;
  bindings?: Record<string, BindingEntry>;
  /** Named security entries referenced by bindings. Each entry is an array of methods in preference order. */
  security?: Record<string, SecurityMethod[]>;
  transforms?: Record<string, Transform>;
  [key: string]: unknown;
}

// -- TransformOrRef helpers --

/** Returns true if the transform is a `$ref` reference to a named transform. */
export function isTransformRef(t: TransformOrRef): t is TransformRef {
  return typeof t.$ref === "string" && t.$ref !== "";
}

/**
 * Resolves a {@link TransformOrRef} to a concrete {@link Transform}.
 * For inline transforms, returns the transform directly. For `$ref` references,
 * looks up the named transform in the provided map. Returns `undefined` if unresolvable.
 */
export function resolveTransform(
  t: TransformOrRef,
  transforms?: Record<string, Transform>,
): Transform | undefined {
  if (!isTransformRef(t)) {
    if (typeof t.type === "string" && typeof t.expression === "string") {
      return { type: t.type, expression: t.expression };
    }
    return undefined;
  }

  const prefix = "#/transforms/";
  const ref = t.$ref!;
  if (!ref.startsWith(prefix)) return undefined;
  const name = ref.slice(prefix.length);
  if (!name || !transforms) return undefined;
  return transforms[name];
}

/**
 * Intentionally untyped JSON Schema representation.
 * Avoids coupling to any one JSON Schema library while preserving
 * arbitrary keys/values structurally.
 */
export type JSONSchema = Record<string, unknown>;

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
  /**
   * Additional names for this operation, equal in standing to its key. The key
   * plus aliases form one flat, document-unique namespace; every name resolves
   * to this operation (see resolveOperation / OBI-T-12).
   */
  aliases?: string[];

  idempotent?: boolean;
  input?: JSONSchema | null;
  output?: JSONSchema | null;

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

/**
 * A JSONata 2.0 transformation expression string.
 *
 * Per OpenBindings v0.2 §6.5, transforms are JSONata expression strings; tools
 * claiming Invoking-class conformance evaluate them per JSONata 2.0 (OBI-T-11).
 */
export type Transform = string;

/**
 * Either an inline transform (a JSONata expression string) or a `$ref` object
 * pointing to a named entry in the document's `transforms` map.
 *
 * Use {@link isTransformRef} to discriminate at runtime.
 */
export type TransformOrRef = Transform | TransformRef;

/** A `$ref` object form pointing to a named transform. */
export interface TransformRef {
  $ref: string;
}

/** Maps an operation to a concrete source with optional input/output transforms. */
export interface BindingEntry {
  operation: string;
  source: string;
  ref?: string;
  priority?: number;
  description?: string;
  deprecated?: boolean;
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
  sources?: Record<string, Source>;
  bindings?: Record<string, BindingEntry>;
  transforms?: Record<string, Transform>;
  [key: string]: unknown;
}

// -- TransformOrRef helpers --

/** Returns true if the transform is a `$ref` reference to a named transform. */
export function isTransformRef(t: TransformOrRef): t is TransformRef {
  return (
    typeof t === "object" &&
    t !== null &&
    typeof (t as TransformRef).$ref === "string" &&
    (t as TransformRef).$ref !== ""
  );
}

/**
 * Resolves a {@link TransformOrRef} to a concrete JSONata expression string.
 * For inline transforms, returns the expression directly. For `$ref`
 * references, looks up the named transform in the provided map. Returns
 * `undefined` if unresolvable.
 */
export function resolveTransform(
  t: TransformOrRef,
  transforms?: Record<string, Transform>,
): Transform | undefined {
  if (!isTransformRef(t)) {
    return typeof t === "string" ? t : undefined;
  }

  const prefix = "#/transforms/";
  const ref = t.$ref;
  if (!ref.startsWith(prefix)) return undefined;
  const name = ref.slice(prefix.length);
  if (!name || !transforms) return undefined;
  return transforms[name];
}

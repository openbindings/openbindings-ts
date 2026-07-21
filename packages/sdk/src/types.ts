/**
 * Intentionally untyped JSON Schema representation.
 * Avoids coupling to any one JSON Schema library while preserving
 * arbitrary keys/values structurally.
 */
/**
 * A JSON Schema 2020-12 value in either of its two forms: an object schema
 * or a boolean schema — §5.2 admits boolean schemas at every schema
 * position (`true` accepts every value, `false` accepts none, `{}` is
 * equivalent to `true`). Intentionally untyped beyond that to avoid
 * coupling to any one JSON Schema library. Well-formedness of a present
 * value is a document rule (OBI-D-17), enforced by validateInterface
 * rather than by this type.
 */
export type JSONSchema = Record<string, unknown> | boolean;

/**
 * Returns the object form of a schema value: an object schema as itself,
 * boolean `true` as `{}`, and boolean `false` as `{"not": {}}` (the
 * equivalent object spellings per JSON Schema 2020-12). Returns undefined
 * when v is neither an object nor a boolean — a malformed schema value
 * (an OBI-D-17 violation, reported by validateInterface).
 */
// `unknown` absorbs `JSONSchema`; the union deliberately documents the type
// callers normally hold while accepting malformed values for the walk.
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
export function schemaObjectForm(v: JSONSchema | unknown): Record<string, unknown> | undefined {
  if (typeof v === "boolean") return v ? {} : { not: {} };
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return undefined;
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

/** Describes a binding source: its governing binding specification and where to find the artifact. */
export interface Source {
  /**
   * The binding-specification identifier governing this source — exact and
   * opaque (core §6: never dereferenced, never range-matched).
   */
  bindingSpec: string;
  location?: string;
  content?: unknown;
  description?: string;
  [key: string]: unknown;
}

/**
 * A JSONata 2.1 transformation expression string.
 *
 * Per OpenBindings v0.2 §5.5, transforms are JSONata expression strings;
 * tools that evaluate transforms do so per JSONata 2.1 (OBI-T-10).
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
  preference?: number;
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
    typeof (t).$ref === "string" &&
    (t).$ref !== ""
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
  // Own property only: a named-transform key such as "constructor" must
  // resolve against the document's own transforms map, never a Function
  // inherited from the map object's prototype chain.
  if (!Object.hasOwn(transforms, name)) return undefined;
  return transforms[name];
}

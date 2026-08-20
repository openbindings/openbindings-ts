/**
 * The typed identity of an operation: its key, plus its input/output types
 * carried as a phantom brand. Inert and interface-free. Codegen emits one per
 * operation under the generated `OperationSignatures` namespace, instantiated
 * with concrete I/O types; dynamic callers use the defaults.
 *
 * TypeScript is structurally typed, so without a brand two signatures with
 * different contracts but the same `{ key }` shape would be mutually assignable
 * and the I/O types would be lost. `__io` (never present at runtime) makes the
 * type carry I and O, mirroring `TypedDocumentNode`. The interface a signature
 * is invoked against is a runtime argument to `OperationInvoker.invoke`, never
 * part of the signature, so one signature works against any interface that
 * declares its key.
 */
export interface OperationSignature<I = unknown, O = unknown> {
  /** The operation key this signature names, resolved alias-aware (OBI-T-12) at invoke time. */
  readonly key: string;
  /** Phantom brand carrying the input/output contract. Never present at runtime. */
  readonly __io?: (input: I) => O;
}

/**
 * Builds an {@link OperationSignature} for an operation key. The one general
 * constructor: codegen calls it with concrete types
 * (`operationSignature<ReindexInput, ReindexOutput>("reindex")`); dynamic
 * callers use the defaults (`operationSignature("reindex")`).
 */
export function operationSignature<I = unknown, O = unknown>(
  key: string,
): OperationSignature<I, O> {
  return { key };
}

/** @openbindings/json-schema: exact, leaf-aware JSON Schema validation over the
 * pinned json-schema-library evaluator. The public surface is `compile` and
 * `Schema.validate` (design/value-api-shape-loop/candidate/json-schema.d.ts).
 * The upstream evaluator owns traversal, references, applicators and
 * annotations; this package fixes the draft and reads the value in place. */
import { compileSchema as compileUpstream } from "json-schema-library";
import type { Draft, JsonSchema, SchemaNode } from "json-schema-library";
import { ValueError } from "@openbindings/json";
import type { Costs, ForcingReason, Value } from "@openbindings/json";
import { counters, external, sizeOf } from "@openbindings/json/advanced";
import type { ValueAccess } from "@openbindings/json/advanced";
import { admit, isAuthenticated } from "@openbindings/json/internal";
import { draft } from "./draft.js";

type UpstreamOptions = NonNullable<Parameters<typeof compileUpstream>[1]>;

/** Compile options: whatever json-schema-library's compileSchema accepts,
 * except `drafts`, which this package fixes to its exact-number, leaf-aware
 * 2020-12 draft. `throwOnInvalidRef` and `throwOnInvalidSchema` default to
 * true here. Raw schemas passed as `remotes` are owned snapshots compiled
 * with the same draft. An explicitly supplied precompiled `remote` registry
 * remains live and takes precedence over `remotes`. */
export type CompileOptions = Omit<UpstreamOptions, "drafts">;

/** One validation report: `valid`, the library's errors (each with a stable
 * `code` such as "multiple-of-error" and `data.pointer` into the instance),
 * and the work counters for this call: `costs.encodes` is the number of
 * Encoded values forced; `costs.forcing["schema-constraint"]` the bytes
 * forced for pattern, format, const, enum and uniqueItems. The report never
 * retains the instance beyond `data.value` on individual errors, which
 * shares the member by reference. */
export interface Validation {
  readonly valid: boolean;
  readonly errors: readonly ValidationError[];
  readonly costs: Costs;
}

/** The library's error record: `code`, `message`, and `data` with `pointer`
 * (RFC 6901, into the instance), the failing `schema` and the offending
 * `value`. `message` renders Decimal digits and Encoded strings, never
 * "[object Object]"; rendering may force one Encoded (reason "diagnostic").
 * `data.value` shares the member. */
export interface ValidationError {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
  readonly data: {
    readonly pointer: string;
    readonly schema?: Value;
    readonly value?: Value;
    readonly [detail: string]: unknown;
  };
}

/** A compiled schema with two validate shapes. */
export interface Schema {
  /** A Validation for a Value, read in place: no tree copy, no projection.
   * Successful string type/length checks use metadata without encoding.
   * Character-dependent constraints and equality fallbacks can force a string
   * once (reason "schema-constraint"); diagnostic messages may also force it.
   * An unasserted format does not force characters. The value caches its text;
   * numeric keywords compare exact digits. A Decimal is a
   * number to `type`. Throws ValueError ERR_JSON_ADMISSION for a value
   * outside the domain, before any keyword runs; never for an invalid
   * instance, which is a report. Validation certifies the logical value
   * only, nothing about byte backing or the exactness of a representation. */
  validate(value: Value): Validation;
  /** A Validation for foreign storage read through a trusted adapter: one
   * import through `external(value, access)`, nothing retained. Encoded-like
   * members reached through `deferredString` behave as above; an adapter
   * without that capability yields its logical string through `scalar`,
   * attributed "schema-constraint". ERR_JSON_ADMISSION carries the adapter's
   * error as `cause`. */
  validate<T>(value: T, access: ValueAccess<T>): Validation;
}

const reasons = Object.keys(counters().forcing) as ForcingReason[];

/** The work between two counter readings, as a frozen Costs. */
function delta(before: Costs, after: Costs): Costs {
  const forcing = {} as Record<ForcingReason, number>;
  for (const reason of reasons) forcing[reason] = after.forcing[reason] - before.forcing[reason];
  return Object.freeze({
    nodesRead: after.nodesRead - before.nodesRead,
    treesBuilt: after.treesBuilt - before.treesBuilt,
    bytesCopied: after.bytesCopied - before.bytesCopied,
    encodes: after.encodes - before.encodes,
    bytesEncoded: after.bytesEncoded - before.bytesEncoded,
    serializations: after.serializations - before.serializations,
    forcing: Object.freeze(forcing),
  });
}

/** The same adapter, with strings that are not deferred attributed to the
 * keyword that reads them. Optional capabilities are copied as own data
 * properties, which is how `external` negotiates them. */
function attributed<T>(access: ValueAccess<T>): ValueAccess<T> {
  if (access === null || typeof access !== "object") return access;
  const wrapped: ValueAccess<T> & Record<string, unknown> = {
    version: access.version,
    kind: value => access.kind(value),
    get: (value, key) => access.get(value, key),
    keys: value => access.keys(value),
    length: value => access.length(value),
    numberToken: value => access.numberToken(value),
    scalar: (value, reason) => access.scalar(value, reason ?? "schema-constraint"),
  };
  for (const name of ["deferredString", "byteLength", "bytes", "copyBytesInto"]) {
    const descriptor = Object.getOwnPropertyDescriptor(access, name);
    if (descriptor && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "function") {
      const capability = descriptor.value as (...args: unknown[]) => unknown;
      wrapped[name] = (...args: unknown[]) => capability.apply(access, args);
    }
  }
  return wrapped;
}

/** The engine's own limit (a stack overflow on a pathological depth) is the
 * declared budget failure, as in the codec. ValueErrors pass through. */
function guarded<T>(operation: () => T): T {
  try { return operation(); }
  catch (cause) {
    if (cause instanceof RangeError && !(cause instanceof ValueError)) {
      throw new ValueError("ERR_JSON_BUDGET", "The engine's own limit was reached before a Limits value", { details: { reason: "engine-stack" }, cause });
    }
    throw cause;
  }
}

/** Compile a schema. Numeric keywords are read as exact tokens: a Decimal or a
 * JavaScript number in the schema document both become digits, so
 * `multipleOf: 0.1` means one tenth. One admission walk of the schema, then
 * the library's compile walk with reference resolution; no instance work.
 * Retains an admitted snapshot of the schema document, never an instance. An
 * invalid schema or an unresolvable reference throws the library's error; a
 * schema outside the Value domain throws ValueError ERR_JSON_ADMISSION. */
export function compile(schema: Value, options?: CompileOptions): Schema {
  const document = admit(schema) as JsonSchema | boolean;
  const { remotes, ...rest } = options ?? {};
  let remote = rest.remote;
  if (remote === undefined && Array.isArray(remotes) && remotes.length > 0) {
    // The upstream would compile remotes with its stock drafts; they get this draft.
    // Admit the entire list before reading ids: caller getters and subsequent
    // mutations must not change an already compiled validator.
    const documents = admit(remotes as unknown as Value) as readonly JsonSchema[];
    const [first, ...others] = documents;
    documents.forEach((item, index) => { if (item.$id == null) throw new Error(`required $id on remotes[${index}] is missing`); });
    remote = compileUpstream(first!, { drafts: [draft] });
    // addRemoteSchema assigns the top-level $id. Give it a private shell;
    // all nested data still comes from our owned snapshot.
    for (const item of others) remote.addRemoteSchema(item.$id as string, { ...item });
  }
  const node = compileUpstream(document, { throwOnInvalidRef: true, throwOnInvalidSchema: true, ...rest, remote, drafts: [draft] });
  return Object.freeze({
    validate<T>(value: T, access?: ValueAccess<T>): Validation {
      const before = counters();
      let instance: unknown = value;
      if (access !== undefined) instance = external(value, attributed(access));
      else if (!isAuthenticated(value)) sizeOf(value as Value); // admission only: in place, no limits, no copy
      const report = guarded(() => node.validate(instance));
      return Object.freeze({
        valid: report.valid,
        errors: Object.freeze(report.errors as unknown as ValidationError[]),
        costs: delta(before, counters()),
      });
    },
  }) as Schema;
}

// ---------------------------------------------------------------------------
// Retired surface. Every name below keeps working until Block 8 deletes it;
// each carries its replacement on its declaration.
// ---------------------------------------------------------------------------
export { compileValueSchema, EXACT_DRAFT_2020, RETAINED_DRAFT_2020 } from "./retained.js";
export type { ValueSchema, ValueValidation } from "./retained.js";
export { valueInstance } from "./values.js";

/** The upstream compiler, re-exported for callers that pass a draft themselves.
 * @deprecated Use `compile`, which fixes the draft and admits the schema. */
export const compileSchema: typeof compileUpstream = compileUpstream;

export type { Draft, SchemaNode };

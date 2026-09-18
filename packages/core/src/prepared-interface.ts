import { canonicalize } from "./canonical-json.js";
import { equal, parse, stringify } from "@openbindings/json";
import { admit } from "@openbindings/json/internal";
import { compileOperationSchema, schemaChildValues, type CompiledSchema } from "./schema-validation.js";
import type {
  BindingEntry,
  DependencyEntry,
  JSONSchema,
  OBInterface,
  Operation,
  Source,
} from "./types.js";
import { validateInterface, type ValidateOptions } from "./validate.js";

export type OperationSchemaPosition = "input" | "output";

export interface PreparedOperationDescriptor {
  readonly canonicalKey: string;
  readonly identifiers: readonly string[];
  readonly operation: Operation;
  readonly bindingKeys: readonly string[];
  readonly dependencyKeys: readonly string[];
}

export interface PreparedDependencyDescriptor {
  readonly key: string;
  readonly dependency: DependencyEntry;
  readonly operation: PreparedOperationDescriptor;
  readonly allowedBindingSpecs?: readonly string[];
  allowsBindingSpec(bindingSpec: string): boolean;
}

export interface PreparedBindingDescriptor {
  readonly key: string;
  readonly binding: BindingEntry;
  readonly operation: PreparedOperationDescriptor;
  readonly source: Source;
  readonly bindingSpec: string;
}

/**
 * Exact identity of an operation's authored boundary contract.
 *
 * `complete` is false when the contract reaches a schema resource that was
 * not embedded in the OBI. Core never fetches such resources implicitly.
 */
export interface PreparedBoundaryContract {
  readonly complete: boolean;
  readonly unavailableReferences: readonly string[];
}

export type BoundaryIdentity = "equal" | "different" | "unavailable";
const contractGraphs = new WeakMap<PreparedBoundaryContract, ContractGraph>();
const contractComparisons = new WeakMap<PreparedBoundaryContract, WeakMap<PreparedBoundaryContract, BoundaryIdentity>>();

/** Compare owned authored values, not serialization or runtime labels. */
export function compareBoundaryContracts(left: PreparedBoundaryContract, right: PreparedBoundaryContract): BoundaryIdentity {
  const a = contractGraphs.get(left), b = contractGraphs.get(right);
  if (!a || !b || !left.complete || !right.complete) return "unavailable";
  const memo = contractComparisons.get(left) ?? new WeakMap<PreparedBoundaryContract, BoundaryIdentity>();
  const cached = memo.get(right);
  if (cached !== undefined) return cached;
  // Owners and their graphs are immutable. This memo retains no foreign
  // owner strongly and caches no capability failure or policy decision.
  const result = equal(a as never, b as never) ? "equal" : "different";
  memo.set(right, result); contractComparisons.set(left, memo);
  return result;
}

let nextSnapshotId = 0;

export interface PrepareInterfaceOptions {
  readonly validation?: ValidateOptions;
}

interface PreparedState {
  readonly snapshot: OBInterface;
  readonly snapshotId: string;
  readonly operations: ReadonlyMap<string, PreparedOperationDescriptor>;
  readonly identifiers: ReadonlyMap<string, PreparedOperationDescriptor>;
  readonly dependencies: ReadonlyMap<string, PreparedDependencyDescriptor>;
  readonly bindings: ReadonlyMap<string, PreparedBindingDescriptor>;
  readonly schemaAnchors: () => ReadonlyMap<string, unknown>;
  readonly schemaValidators: Map<string, CompiledSchema>;
  readonly boundaryContracts: Map<string, Promise<PreparedBoundaryContract>>;
}

const EMPTY_KEYS: readonly string[] = Object.freeze([]);

/**
 * A validated, immutable, privately owned semantic snapshot of one OBI.
 *
 * Instances are nominal: callers can obtain one only through
 * {@link prepareInterface}. The snapshot owns all indexes and compiled-schema
 * caches needed by composition and invocation, so those paths never have to
 * clone or re-index a raw document.
 */
export class PreparedInterface {
  readonly #state: PreparedState;

  private constructor(state: PreparedState) {
    this.#state = state;
    Object.freeze(this);
  }

  /** Local correlation only; never equality, persistent identity or authority. */
  get snapshotId(): string {
    return this.#state.snapshotId;
  }

  /** Explicit fallible RFC 8785 export. Failure leaves this owner usable. */
  async exportJCS(): Promise<Readonly<{ canonical: string; revision: string }>> {
    const candidate = canonicalize(JSON.parse(stringify(this.#state.snapshot as never)));
    if (candidate === undefined || !equal(this.#state.snapshot as never, parse(candidate))) {
      throw new TypeError("openbindings: JCS export would change a carried JSON value");
    }
    return Object.freeze({ canonical: candidate, revision: await sha256(candidate) });
  }

  /** A private-copy, deeply frozen OBI snapshot. */
  get interfaceSnapshot(): OBInterface {
    return this.#state.snapshot;
  }

  operationKeys(): readonly string[] {
    return Object.freeze([...this.#state.operations.keys()]);
  }

  dependencyKeys(): readonly string[] {
    return Object.freeze([...this.#state.dependencies.keys()]);
  }

  bindingKeys(): readonly string[] {
    return Object.freeze([...this.#state.bindings.keys()]);
  }

  operation(identifier: string): PreparedOperationDescriptor | undefined {
    return this.#state.identifiers.get(identifier);
  }

  dependency(key: string): PreparedDependencyDescriptor | undefined {
    return this.#state.dependencies.get(key);
  }

  binding(key: string): PreparedBindingDescriptor | undefined {
    return this.#state.bindings.get(key);
  }

  bindingsForOperation(identifier: string): readonly PreparedBindingDescriptor[] {
    const operation = this.operation(identifier);
    if (!operation) return Object.freeze([]);
    return Object.freeze(
      operation.bindingKeys.map(key => this.#state.bindings.get(key)!),
    );
  }

  /** Compiles one boundary schema at most once for this prepared snapshot. */
  schemaValidator(
    operationIdentifier: string,
    position: OperationSchemaPosition,
  ): CompiledSchema | undefined {
    const descriptor = this.operation(operationIdentifier);
    if (!descriptor) return undefined;
    if (descriptor.operation[position] == null) return undefined;
    const cacheKey = `${descriptor.canonicalKey}\u0000${position}`;
    let validator = this.#state.schemaValidators.get(cacheKey);
    if (!validator) {
      validator = compileOperationSchema(
        this.#state.snapshot,
        descriptor.canonicalKey,
        position,
      );
      this.#state.schemaValidators.set(cacheKey, validator);
    }
    return validator;
  }

  /**
   * Computes the exact authored boundary-contract identity once per operation.
   * Array order, schema keyword spelling, and input/output presence all remain
   * significant. Only schema resources reachable by reference are included.
   */
  boundaryContract(
    operationIdentifier: string,
  ): Promise<PreparedBoundaryContract> | undefined {
    const descriptor = this.operation(operationIdentifier);
    if (!descriptor) return undefined;
    let prepared = this.#state.boundaryContracts.get(descriptor.canonicalKey);
    if (!prepared) {
      prepared = Promise.resolve().then(() => prepareBoundaryContract(
        this.#state.snapshot,
        descriptor.canonicalKey,
        descriptor.operation,
        this.#state.schemaAnchors,
      ));
      this.#state.boundaryContracts.set(descriptor.canonicalKey, prepared);
    }
    return prepared;
  }

  /** @internal The only construction path; private state provides nominality. */
  static create(
    iface: OBInterface,
    options?: PrepareInterfaceOptions,
  ): PreparedInterface {
    if (!iface || typeof iface !== "object") {
      throw new TypeError("openbindings: interface is required");
    }
    // Admission is the private, deeply frozen copy this snapshot promises:
    // it refuses anything outside the JSON domain and freezes what it returns,
    // so a caller cannot reach back into it afterwards.
    const snapshot = admit(iface as never) as unknown as OBInterface;
    validateInterface(snapshot, options?.validation);

    // Public enumeration stays deterministic without canonicalizing values.
    const entries = sortedEntries;
    const operationEntries = entries(snapshot.operations);
    const dependencyEntries = entries(snapshot.dependencies ?? {});
    const bindingEntries = entries(snapshot.bindings ?? {});

    const operations = new Map<string, PreparedOperationDescriptor>();
    const identifiers = new Map<string, PreparedOperationDescriptor>();
    const bindingKeysByOperation = groupedEntryKeys(
      bindingEntries,
      binding => binding.operation,
    );
    const dependencyKeysByOperation = groupedEntryKeys(
      dependencyEntries,
      dependency => dependency.operation,
    );

    for (const [canonicalKey, operation] of operationEntries) {
      const names = Object.freeze([canonicalKey, ...(operation.aliases ?? [])]);
      const descriptor = Object.freeze({
        canonicalKey,
        identifiers: names,
        operation,
        bindingKeys: freezeKeys(bindingKeysByOperation.get(canonicalKey)),
        dependencyKeys: freezeKeys(dependencyKeysByOperation.get(canonicalKey)),
      });
      operations.set(canonicalKey, descriptor);
      for (const name of names) identifiers.set(name, descriptor);
    }

    const dependencies = new Map<string, PreparedDependencyDescriptor>();
    for (const [key, dependency] of dependencyEntries) {
      const operation = operations.get(dependency.operation)!;
      const allowed = dependency.bindingSpecs === undefined
        ? undefined
        : new Set(dependency.bindingSpecs);
      dependencies.set(key, Object.freeze({
        key,
        dependency,
        operation,
        ...(dependency.bindingSpecs === undefined
          ? {}
          : { allowedBindingSpecs: Object.freeze([...dependency.bindingSpecs]) }),
        allowsBindingSpec(bindingSpec: string): boolean {
          return allowed === undefined || allowed.has(bindingSpec);
        },
      }));
    }

    const bindings = new Map<string, PreparedBindingDescriptor>();
    for (const [key, binding] of bindingEntries) {
      const source = snapshot.sources?.[binding.source];
      // validateInterface establishes both references.
      bindings.set(key, Object.freeze({
        key,
        binding,
        operation: operations.get(binding.operation)!,
        source: source!,
        bindingSpec: source!.bindingSpec,
      }));
    }

    // The private clone remains mutable only during validation and index
    // construction, where ordinary objects are materially faster. It is
    // deeply frozen before the PreparedInterface construction boundary.
    deepFreeze(snapshot);

    return new PreparedInterface({
      snapshot,
      snapshotId: `snapshot:${++nextSnapshotId}`,
      operations,
      identifiers,
      dependencies,
      bindings,
      schemaAnchors: memoizedSchemaAnchors(snapshot),
      schemaValidators: new Map(),
      boundaryContracts: new Map(),
    });
  }
}

/**
 * Validates and prepares an OBI, or returns an already-prepared value as-is.
 */
export function prepareInterface(
  iface: OBInterface | PreparedInterface,
  options?: PrepareInterfaceOptions,
): Promise<PreparedInterface> {
  return iface instanceof PreparedInterface
    ? Promise.resolve(iface)
    : Promise.resolve().then(() => PreparedInterface.create(iface, options));
}

function sortedEntries<T>(
  map: Record<string, T> | undefined,
): [string, T][] {
  return Object.entries(map ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function groupedEntryKeys<T>(
  entries: readonly (readonly [string, T])[],
  group: (value: T) => string,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [key, value] of entries) {
    const groupKey = group(value);
    const keys = result.get(groupKey);
    if (keys) keys.push(key);
    else result.set(groupKey, [key]);
  }
  return result;
}

function freezeKeys(keys: string[] | undefined): readonly string[] {
  return keys === undefined ? EMPTY_KEYS : Object.freeze(keys);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const key in value) {
    if (Object.hasOwn(value, key)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return Object.freeze(value);
}

async function sha256(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("openbindings: Web Crypto SHA-256 is unavailable");
  }
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${[...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

interface ContractGraph {
  readonly input: { readonly present: boolean; readonly schema?: JSONSchema | null };
  readonly output: { readonly present: boolean; readonly schema?: JSONSchema | null };
  readonly resources: Record<string, unknown>;
  readonly unavailableReferences: readonly string[];
}

function prepareBoundaryContract(
  iface: OBInterface,
  operationKey: string,
  operation: Operation,
  anchors: () => ReadonlyMap<string, unknown>,
): PreparedBoundaryContract {
  const resources: Record<string, unknown> = {};
  const unavailable = new Set<string>();
  const visitedObjects = new WeakSet<object>();
  const visitedReferences = new Set<string>();

  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null || visitedObjects.has(value)) return;
    visitedObjects.add(value);
    if (Array.isArray(value)) {
      for (const member of value) visit(member);
      return;
    }
    const object = value as Record<string, unknown>;
    for (const keyword of ["$ref", "$dynamicRef"] as const) {
      const reference = object[keyword];
      if (typeof reference !== "string" || visitedReferences.has(reference)) continue;
      visitedReferences.add(reference);
      const target = resolveEmbeddedReference(iface, reference, anchors);
      if (target === undefined) {
        unavailable.add(reference);
      } else {
        resources[reference] = target;
        visit(target);
      }
    }
    for (const child of schemaChildValues(object)) visit(child);
  };

  if (Object.hasOwn(operation, "input")) visit(operation.input);
  if (Object.hasOwn(operation, "output")) visit(operation.output);

  const graph: ContractGraph = {
    input: Object.freeze({
      present: Object.hasOwn(operation, "input"),
      ...(Object.hasOwn(operation, "input") ? { schema: operation.input } : {}),
    }),
    output: Object.freeze({
      present: Object.hasOwn(operation, "output"),
      ...(Object.hasOwn(operation, "output") ? { schema: operation.output } : {}),
    }),
    resources: Object.fromEntries(sortedEntries(resources)),
    unavailableReferences: Object.freeze([...unavailable].sort()),
  };
  const contract = Object.freeze({
    complete: unavailable.size === 0,
    unavailableReferences: graph.unavailableReferences,
  });
  contractGraphs.set(contract, deepFreeze(graph));
  return contract;
}

function schemaAnchors(iface: OBInterface): ReadonlyMap<string, unknown> {
  const anchors = new Map<string, unknown>();
  const seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const member of value) visit(member);
      return;
    }
    const object = value as Record<string, unknown>;
    for (const keyword of ["$id", "$anchor", "$dynamicAnchor"] as const) {
      const identifier = object[keyword];
      if (typeof identifier !== "string") continue;
      const key = keyword === "$id" ? identifier : `#${identifier}`;
      if (!anchors.has(key)) anchors.set(key, value);
    }
    for (const child of schemaChildValues(object)) visit(child);
  };
  for (const schema of Object.values(iface.schemas ?? {})) visit(schema);
  for (const operation of Object.values(iface.operations)) {
    visit(operation.input);
    visit(operation.output);
  }
  return anchors;
}

function memoizedSchemaAnchors(
  iface: OBInterface,
): () => ReadonlyMap<string, unknown> {
  let prepared: ReadonlyMap<string, unknown> | undefined;
  return () => {
    prepared ??= schemaAnchors(iface);
    return prepared;
  };
}

function resolveEmbeddedReference(
  iface: OBInterface,
  reference: string,
  getAnchors: () => ReadonlyMap<string, unknown>,
): unknown {
  if (reference === "#") return iface;
  if (reference.startsWith("#/")) return resolveJsonPointer(iface, reference.slice(1));
  const anchors = getAnchors();
  const exact = anchors.get(reference);
  if (exact !== undefined) return exact;
  const hash = reference.indexOf("#");
  if (hash >= 0) {
    const resource = anchors.get(reference.slice(0, hash));
    const fragment = reference.slice(hash + 1);
    if (resource !== undefined) {
      if (!fragment) return resource;
      if (fragment.startsWith("/")) return resolveJsonPointer(resource, fragment);
      return findAnchor(resource, fragment);
    }
  }
  return undefined;
}

function resolveJsonPointer(root: unknown, pointer: string): unknown {
  let value = root;
  for (const token of pointer.split("/").slice(1)) {
    if (typeof value !== "object" || value === null) return undefined;
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function findAnchor(root: unknown, name: string): unknown {
  const seen = new WeakSet<object>();
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const child of value as unknown[]) pending.push(child);
    } else {
      const object = value as Record<string, unknown>;
      if (object.$anchor === name || object.$dynamicAnchor === name) return value;
      for (const child of schemaChildValues(object)) pending.push(child);
    }
  }
  return undefined;
}

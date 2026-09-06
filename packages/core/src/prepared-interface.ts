import { canonicalize, canonicalizedValue } from "./canonical-json.js";
import { compileOperationSchema, type CompiledSchema } from "./schema-validation.js";
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
  readonly revision: string;
  readonly canonical: string;
  readonly complete: boolean;
  readonly unavailableReferences: readonly string[];
}

export interface PrepareInterfaceOptions {
  readonly validation?: ValidateOptions;
}

interface PreparedState {
  readonly snapshot: OBInterface;
  readonly canonical: string;
  readonly revision: string;
  readonly operations: ReadonlyMap<string, PreparedOperationDescriptor>;
  readonly identifiers: ReadonlyMap<string, PreparedOperationDescriptor>;
  readonly dependencies: ReadonlyMap<string, PreparedDependencyDescriptor>;
  readonly bindings: ReadonlyMap<string, PreparedBindingDescriptor>;
  readonly schemaAnchors: () => ReadonlyMap<string, unknown>;
  readonly schemaValidators: Map<string, CompiledSchema>;
  readonly boundaryContracts: Map<string, Promise<PreparedBoundaryContract>>;
  readonly boundaryRevisions: Map<string, string>;
}

const EMPTY_KEYS: readonly string[] = Object.freeze([]);

/**
 * A validated, immutable, content-addressed semantic snapshot of one OBI.
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

  /** SHA-256 of the RFC 8785 canonical OBI JSON. */
  get revision(): string {
    return this.#state.revision;
  }

  /** The RFC 8785 canonical JSON used to create this prepared value. */
  get canonical(): string {
    return this.#state.canonical;
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
    const contractRevision = this.#state.boundaryRevisions.get(descriptor.canonicalKey);
    const cacheKey = `${contractRevision ?? descriptor.canonicalKey}\u0000${position}`;
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
      prepared = prepareBoundaryContract(
        this.#state.snapshot,
        descriptor.canonicalKey,
        descriptor.operation,
        this.#state.schemaAnchors,
      ).then(contract => {
        this.#state.boundaryRevisions.set(descriptor.canonicalKey, contract.revision);
        return contract;
      });
      this.#state.boundaryContracts.set(descriptor.canonicalKey, prepared);
    }
    return prepared;
  }

  /** @internal The only construction path; private state provides nominality. */
  static async create(
    iface: OBInterface,
    options?: PrepareInterfaceOptions,
  ): Promise<PreparedInterface> {
    if (!iface || typeof iface !== "object") {
      throw new TypeError("openbindings: interface is required");
    }
    const canonical = canonicalizedValue(iface);
    if (canonical === undefined) {
      throw new TypeError("openbindings: interface is not representable as JSON");
    }
    const serialized = canonical.canonical;
    const revisionPromise = sha256(serialized);
    // Mark the concurrent digest handled even when later synchronous
    // validation rejects; the same promise is still awaited on success.
    void revisionPromise.catch(() => {});
    // R1 deliberately creates authority from the canonical bytes rather than
    // trusting even the equivalent normalization graph used to produce them.
    const snapshot = JSON.parse(serialized) as OBInterface;
    validateInterface(snapshot, options?.validation);

    // `snapshot` was parsed from canonical JSON, so its own string-key order
    // is already the required UTF-16 order. Materialize each top-level entry
    // array once: re-sorting/re-enumerating the 5,000-entry binding and
    // operation maps here added measurable cold tail latency without changing
    // any observable ordering.
    const entries = canonical.requiresManualOrdering ? sortedEntries : Object.entries;
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
      canonical: serialized,
      revision: await revisionPromise,
      operations,
      identifiers,
      dependencies,
      bindings,
      schemaAnchors: memoizedSchemaAnchors(snapshot),
      schemaValidators: new Map(),
      boundaryContracts: new Map(),
      boundaryRevisions: new Map(),
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
    : PreparedInterface.create(iface, options);
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

async function prepareBoundaryContract(
  iface: OBInterface,
  operationKey: string,
  operation: Operation,
  anchors: () => ReadonlyMap<string, unknown>,
): Promise<PreparedBoundaryContract> {
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
    for (const child of Object.values(object)) visit(child);
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
  const serialized = canonicalize(graph);
  if (serialized === undefined) {
    throw new TypeError(
      `openbindings: operation ${JSON.stringify(operationKey)} contract is not representable as JSON`,
    );
  }
  return Object.freeze({
    revision: await sha256(serialized),
    canonical: serialized,
    complete: unavailable.size === 0,
    unavailableReferences: graph.unavailableReferences,
  });
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
    for (const child of Object.values(object)) visit(child);
  };
  visit(iface.schemas);
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
      for (const child of Object.values(object)) pending.push(child);
    }
  }
  return undefined;
}

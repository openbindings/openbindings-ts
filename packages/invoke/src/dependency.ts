import type { CompatibilityIssue } from "@openbindings/compare";
import { checkOperationCompatibility } from "@openbindings/compare";
import {
  DependencyNotFoundError,
  lookupDependency,
  type BindingSpecInfo,
  type DependencyEntry,
  type OBInterface,
  type Operation,
} from "@openbindings/core";
import {
  InvocationError,
  type ContextRequiredDetails,
  type Invocation,
} from "./invocation.js";
import type { InvokeOptions } from "./invoker-types.js";
import type {
  PreparedOperation,
} from "./operation-invoker.js";
import { snapshotInterface } from "./operation-invoker.js";
import type { OperationSignature } from "./operation-signature.js";

/**
 * A typed identity for one dependency key in a consumer OBI.
 *
 * The signature intentionally carries no operation key or binding-spec list:
 * those declarations remain authoritative in the OBI's dependency entry.
 */
export interface DependencySignature<I = unknown, O = unknown> {
  readonly key: string;
  /** Phantom brand carrying the dependency's operation I/O. */
  readonly __io?: (input: I) => O;
}

/** Creates a dynamic dependency identity whose contract types remain unknown. */
export function dependencySignature(
  key: string,
): DependencySignature<unknown, unknown> {
  if (!key.trim()) throw new TypeError("openbindings: dependency key is required");
  return { key };
}

/**
 * Derives a dependency identity's I/O from an operation signature. Generated
 * catalogs use this path so dependency and operation types cannot drift.
 */
export function dependencySignatureFromOperation<I, O>(
  key: string,
  _operation: OperationSignature<I, O>,
): DependencySignature<I, O> {
  if (!key.trim()) throw new TypeError("openbindings: dependency key is required");
  return { key };
}

/**
 * Explicit escape hatch for callers asserting dependency I/O without codegen.
 * Runtime composition still verifies the OBI relationship and contract.
 */
export function unsafeDependencySignature<I, O>(
  key: string,
): DependencySignature<I, O> {
  if (!key.trim()) throw new TypeError("openbindings: dependency key is required");
  return { key };
}

/** Minimal operation-preparation capability required from a provider runtime. */
export interface InterfaceProviderInvoker {
  bindingSpecs(): BindingSpecInfo[];
  prepareOperationHandle<I = unknown, O = unknown>(
    iface: OBInterface,
    signature: OperationSignature<I, O>,
    options?: InvokeOptions,
  ): Promise<PreparedOperation<I, O>>;
}

/**
 * One application-supplied provider candidate.
 *
 * The interface declares concrete bindings; the invoker prepares exact,
 * immutable realizations. Collection, lifetime, and preference are
 * application-owned.
 */
export interface InterfaceProvider {
  readonly interface: OBInterface;
  readonly invoker: InterfaceProviderInvoker;
  readonly label?: string;
  readonly preference?: number;
}

/** Stable, language-neutral classification for a rejected provider candidate. */
export type DependencyAssessmentCode =
  | "provider_interface_required"
  | "provider_interface_invalid"
  | "provider_invoker_required"
  | "provider_preference_invalid"
  | "operation_missing"
  | "operation_incompatible"
  | "operation_unbound"
  | "source_missing"
  | "binding_spec_disallowed"
  | "binding_spec_unsupported"
  | "preparation_failed";

/** Structured invocation-layer failure retained from preparation. */
export interface DependencyAssessmentFailure {
  readonly code: string;
  readonly data?: unknown;
}

/** Why one provider operation or binding did not become a usable match. */
export interface DependencyAssessment {
  readonly provider: InterfaceProvider;
  readonly code: DependencyAssessmentCode;
  readonly providerOperationKey?: string;
  readonly bindingKey?: string;
  readonly bindingSpec?: string;
  readonly issues: CompatibilityIssue[];
  readonly failure?: DependencyAssessmentFailure;
  readonly reason?: string;
}

/** Per-call options for a match whose concrete binding is already pinned. */
export type DependencyInvokeOptions = Omit<InvokeOptions, "bindingKey">;

/** One compatible, invocable, binding-level realization of a dependency. */
export interface DependencyMatch<I = unknown, O = unknown> {
  readonly signature: DependencySignature<I, O>;
  readonly consumer: OBInterface;
  readonly dependency: DependencyEntry;
  readonly dependencyKey: string;
  readonly requiredOperationKey: string;
  readonly correspondenceIdentifier: string;
  readonly provider: InterfaceProvider;
  /** Finite caller-owned preference captured exactly once during matching. */
  readonly providerPreference: number;
  readonly providerOperationKey: string;
  readonly bindingKey: string;
  readonly bindingSpec: string;
  readonly knownContextRequirements: ContextRequiredDetails | null;
  invoke(options?: DependencyInvokeOptions): Invocation<I, O>;
  prepare(options?: DependencyInvokeOptions): Promise<ContextRequiredDetails | null>;
}

/** Every usable binding-level match plus assessments of rejected candidates. */
export interface DependencyMatches<I = unknown, O = unknown> {
  readonly matches: readonly DependencyMatch<I, O>[];
  readonly assessments: readonly DependencyAssessment[];
}

/** Lifecycle controls for dependency matching. */
export interface DependencyMatchOptions {
  /** Cancels matching and is forwarded to side-effect-free binding preflight. */
  readonly signal?: AbortSignal;
}

/** Conservative route-to-one dependency-resolution result. */
export type DependencyResolution<I = unknown, O = unknown> =
  | { readonly status: "available"; readonly match: DependencyMatch<I, O> }
  | { readonly status: "ambiguous"; readonly matches: readonly DependencyMatch<I, O>[] }
  | { readonly status: "unavailable"; readonly assessments: readonly DependencyAssessment[] };

interface RankedMatch<I, O> {
  preference: number;
  providerIndex: number;
  match: DependencyMatch<I, O>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function structuredFailure(
  error: unknown,
): DependencyAssessmentFailure | undefined {
  if (!(error instanceof InvocationError)) return undefined;
  return {
    code: error.code,
    ...(error.data === undefined ? {} : { data: error.data }),
  };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("dependency matching was cancelled", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function operationIdentifiers(key: string, operation: Operation): Set<string> {
  return new Set([key, ...(operation.aliases ?? [])]);
}

function sharedIdentifiers(
  required: Set<string>,
  providerKey: string,
  providerOperation: Operation,
): string[] {
  return [...operationIdentifiers(providerKey, providerOperation)]
    .filter(identifier => required.has(identifier))
    .sort();
}

function makeMatch<I, O>(
  signature: DependencySignature<I, O>,
  consumer: OBInterface,
  dependency: DependencyEntry,
  requiredOperationKey: string,
  correspondenceIdentifier: string,
  provider: InterfaceProvider,
  providerPreference: number,
  prepared: PreparedOperation<I, O>,
): DependencyMatch<I, O> {
  const match: DependencyMatch<I, O> = {
    signature: Object.freeze({ key: signature.key }),
    consumer,
    dependency,
    dependencyKey: signature.key,
    requiredOperationKey,
    correspondenceIdentifier,
    provider,
    providerPreference,
    providerOperationKey: prepared.canonicalOperation,
    bindingKey: prepared.bindingKey,
    bindingSpec: prepared.bindingSpec,
    knownContextRequirements: prepared.knownContextRequirements,
    invoke(options?: DependencyInvokeOptions): Invocation<I, O> {
      return prepared.invoke(options);
    },
    prepare(options?: DependencyInvokeOptions): Promise<ContextRequiredDetails | null> {
      return prepared.prepare(options);
    },
  };
  return Object.freeze(match);
}

/**
 * Enumerates every concrete binding-level realization of a named dependency.
 *
 * Matching is deliberately policy-neutral. Provider order, operation/alias
 * order, binding order, and the dependency's `bindingSpecs` order elect
 * nothing. Results are ordered for stable diagnostics by caller-owned
 * preference, then provider input order, provider operation key, and binding
 * key; route-to-one resolution still treats an equal highest preference as
 * ambiguous.
 */
export async function matchDependency<I = unknown, O = unknown>(
  consumer: OBInterface,
  signature: DependencySignature<I, O>,
  providers: readonly InterfaceProvider[],
  options?: DependencyMatchOptions,
): Promise<DependencyMatches<I, O>> {
  const consumerSnapshot = snapshotInterface(consumer);
  const resolved = lookupDependency(consumerSnapshot, signature.key);
  if (!resolved) {
    throw new DependencyNotFoundError(
      signature.key,
      Object.keys(consumerSnapshot.dependencies ?? {}).sort(),
    );
  }

  const requiredIdentifiers = operationIdentifiers(
    resolved.operationKey,
    resolved.operation,
  );
  const allowedSpecs = resolved.dependency.bindingSpecs
    ? new Set(resolved.dependency.bindingSpecs)
    : undefined;
  const assessments: DependencyAssessment[] = [];
  const ranked: RankedMatch<I, O>[] = [];

  for (const [providerIndex, provider] of providers.entries()) {
    throwIfAborted(options?.signal);

    if (!provider?.interface) {
      assessments.push({
        provider,
        code: "provider_interface_required",
        issues: [],
        reason: "provider interface is required",
      });
      continue;
    }
    if (!provider.invoker || typeof provider.invoker.prepareOperationHandle !== "function") {
      assessments.push({
        provider,
        code: "provider_invoker_required",
        issues: [],
        reason: "provider operation preparer is required",
      });
      continue;
    }
    const preference = provider.preference ?? 0;
    if (!Number.isFinite(preference)) {
      assessments.push({
        provider,
        code: "provider_preference_invalid",
        issues: [],
        reason: "provider preference must be a finite number",
      });
      continue;
    }

    const installedSpecs = new Set(
      provider.invoker.bindingSpecs().map(info => info.bindingSpec),
    );
    let providerInterface: OBInterface;
    try {
      providerInterface = provider.interface === consumer
        ? consumerSnapshot
        : snapshotInterface(provider.interface);
    } catch (error: unknown) {
      assessments.push({
        provider,
        code: "provider_interface_invalid",
        issues: [],
        reason: `provider interface could not be snapshotted: ${errorMessage(error)}`,
      });
      continue;
    }
    const correspondences = Object.entries(providerInterface.operations)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([providerOperationKey, providerOperation]) => ({
        providerOperationKey,
        shared: sharedIdentifiers(
          requiredIdentifiers,
          providerOperationKey,
          providerOperation,
        ),
      }))
      .filter(candidate => candidate.shared.length > 0);

    if (correspondences.length === 0) {
      assessments.push({
        provider,
        code: "operation_missing",
        issues: [{ operation: resolved.operationKey, kind: "missing" }],
        reason: "provider carries no corresponding operation identifier",
      });
      continue;
    }

    for (const correspondence of correspondences) {
      throwIfAborted(options?.signal);
      const correspondenceIdentifier = correspondence.shared[0]!;
      const issues =
        consumerSnapshot === providerInterface &&
        resolved.operationKey === correspondence.providerOperationKey
          ? []
          : await checkOperationCompatibility(
              consumerSnapshot,
              correspondenceIdentifier,
              providerInterface,
            );
      throwIfAborted(options?.signal);
      if (issues.length > 0) {
        assessments.push({
          provider,
          code: "operation_incompatible",
          providerOperationKey: correspondence.providerOperationKey,
          issues,
        });
        continue;
      }

      const bindings = Object.entries(providerInterface.bindings ?? {})
        .filter(([, binding]) => binding.operation === correspondence.providerOperationKey)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      if (bindings.length === 0) {
        assessments.push({
          provider,
          code: "operation_unbound",
          providerOperationKey: correspondence.providerOperationKey,
          issues: [],
          reason: "compatible operation has no concrete binding",
        });
        continue;
      }

      for (const [bindingKey, binding] of bindings) {
        throwIfAborted(options?.signal);
        const sources = providerInterface.sources;
        const source =
          sources && Object.hasOwn(sources, binding.source)
            ? sources[binding.source]
            : undefined;
        if (!source) {
          assessments.push({
            provider,
            code: "source_missing",
            providerOperationKey: correspondence.providerOperationKey,
            bindingKey,
            issues: [],
            reason: `binding references unknown source ${JSON.stringify(binding.source)}`,
          });
          continue;
        }
        if (allowedSpecs && !allowedSpecs.has(source.bindingSpec)) {
          assessments.push({
            provider,
            code: "binding_spec_disallowed",
            providerOperationKey: correspondence.providerOperationKey,
            bindingKey,
            bindingSpec: source.bindingSpec,
            issues: [],
            reason: "binding specification is not allowed by the dependency",
          });
          continue;
        }
        if (!installedSpecs.has(source.bindingSpec)) {
          assessments.push({
            provider,
            code: "binding_spec_unsupported",
            providerOperationKey: correspondence.providerOperationKey,
            bindingKey,
            bindingSpec: source.bindingSpec,
            issues: [],
            reason: "provider invoker does not support the binding specification",
          });
          continue;
        }

        try {
          const providerSignature: OperationSignature<I, O> = {
            key: correspondence.providerOperationKey,
          };
          const prepared = await abortable(
            provider.invoker.prepareOperationHandle(
              providerInterface,
              providerSignature,
              { bindingKey, signal: options?.signal },
            ),
            options?.signal,
          );
          ranked.push({
            preference,
            providerIndex,
            match: makeMatch(
              signature,
              consumerSnapshot,
              resolved.dependency,
              resolved.operationKey,
              correspondenceIdentifier,
              provider,
              preference,
              prepared,
            ),
          });
        } catch (error: unknown) {
          if (options?.signal?.aborted) throw abortReason(options.signal);
          const failure = structuredFailure(error);
          assessments.push({
            provider,
            code: "preparation_failed",
            providerOperationKey: correspondence.providerOperationKey,
            bindingKey,
            bindingSpec: source.bindingSpec,
            issues: [],
            ...(failure === undefined ? {} : { failure }),
            reason: errorMessage(error),
          });
        }
      }
    }
  }

  ranked.sort((a, b) =>
    b.preference - a.preference ||
    a.providerIndex - b.providerIndex ||
    (a.match.providerOperationKey < b.match.providerOperationKey ? -1 :
      a.match.providerOperationKey > b.match.providerOperationKey ? 1 :
      a.match.bindingKey < b.match.bindingKey ? -1 :
      a.match.bindingKey > b.match.bindingKey ? 1 : 0),
  );
  return Object.freeze({
    matches: Object.freeze(ranked.map(candidate => candidate.match)),
    assessments: Object.freeze(assessments),
  });
}

/**
 * Resolves one named dependency for route-to-one use.
 *
 * Only explicit caller-owned provider preference participates. A unique
 * highest-preference binding-level realization is available, an equal highest
 * tie is ambiguous, and no matches is unavailable.
 */
export async function resolveDependency<I = unknown, O = unknown>(
  consumer: OBInterface,
  signature: DependencySignature<I, O>,
  providers: readonly InterfaceProvider[],
  options?: DependencyMatchOptions,
): Promise<DependencyResolution<I, O>> {
  const result = await matchDependency(consumer, signature, providers, options);
  if (result.matches.length === 0) {
    return Object.freeze({ status: "unavailable", assessments: result.assessments });
  }
  const highest = result.matches[0]!.providerPreference;
  const preferred = result.matches.filter(
    match => match.providerPreference === highest,
  );
  if (preferred.length !== 1) {
    return Object.freeze({
      status: "ambiguous",
      matches: Object.freeze(preferred),
    });
  }
  return Object.freeze({ status: "available", match: preferred[0]! });
}

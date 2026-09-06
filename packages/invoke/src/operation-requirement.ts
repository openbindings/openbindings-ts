import type { CompatibilityIssue } from "@openbindings/compare";
import { checkOperationCompatibility } from "@openbindings/compare";
import { OperationNotFoundError } from "@openbindings/core";
import type { ContextRequiredDetails, Invocation } from "./invocation.js";
import type { InvokeOptions } from "./invoker-types.js";
import type { OperationInvoker } from "./operation-invoker.js";
import type { OperationSignature } from "./operation-signature.js";
import { allOperationIdentifiers, resolveOperation } from "@openbindings/core";
import type { OBInterface } from "@openbindings/core";

/**
 * One operation a consumer needs: its required contract and typed identifier.
 *
 * The interface is an ordinary OBI compatibility target, commonly unbound.
 * This type adds no consumer fields or optionality semantics to that document;
 * it merely pairs the existing runtime contract with the signature application
 * code already invokes through.
 *
 * @deprecated Use an OBI `dependencies` entry, `PreparedInterface`, and
 * `CompositionSession`. This compatibility family remains available during
 * the 0.2 migration but receives no new features.
 */
export interface OperationRequirement<I = unknown, O = unknown> {
  readonly interface: OBInterface;
  readonly signature: OperationSignature<I, O>;
}

/**
 * Pairs a required interface with one operation it carries.
 * @deprecated Use a generated dependency signature and `CompositionSession`.
 */
export function operationRequirement<I = unknown, O = unknown>(
  iface: OBInterface,
  signature: OperationSignature<I, O>,
): OperationRequirement<I, O> {
  if (!resolveOperation(iface, signature.key)) {
    throw new OperationNotFoundError(signature.key, allOperationIdentifiers(iface));
  }
  return { interface: iface, signature };
}

/**
 * One concrete interface the application can use to satisfy requirements.
 *
 * The invoker, installed binding implementations, label, and preference are
 * all application-owned runtime state. The SDK stores no registry. `label` is
 * diagnostic only and never becomes interface identity. Higher preference
 * wins; equal highest preferences remain ambiguous.
 *
 * @deprecated Use `PreparedProvider` and `ProviderRegistration`.
 */
export interface OperationImplementation {
  readonly interface: OBInterface;
  readonly invoker: OperationInvoker;
  readonly label?: string;
  readonly preference?: number;
}

/** Why one concrete interface did not become an invocable match. */
export interface OperationImplementationAssessment {
  readonly implementation: OperationImplementation;
  readonly issues: CompatibilityIssue[];
  readonly reason?: string;
}

/** Lifecycle controls for compatibility and invocability matching. */
export interface OperationRequirementMatchOptions {
  /**
   * Cancels matching and is forwarded to binding preflight. Matching performs
   * no invocation or side effect; cancellation only abandons discovery work.
   */
  readonly signal?: AbortSignal;
}

/**
 * A compatible, invocable realization of one requirement.
 *
 * `knownContextRequirements` is the advisory result of side-effect-free
 * preflight. Null means no requirement was knowable during resolution, not a
 * guarantee that live invocation cannot raise CONTEXT_REQUIRED.
 */
export interface OperationMatch<I = unknown, O = unknown> {
  readonly requirement: OperationRequirement<I, O>;
  readonly implementation: OperationImplementation;
  readonly canonicalOperation: string;
  readonly knownContextRequirements: ContextRequiredDetails | null;
  invoke(options?: InvokeOptions): Invocation<I, O>;
  prepare(options?: InvokeOptions): Promise<ContextRequiredDetails | null>;
}

/** All compatible, invocable matches plus every rejected candidate assessment. */
export interface OperationRequirementMatches<I = unknown, O = unknown> {
  /** Ordered by caller-owned preference (higher first), preserving input order across ties. */
  readonly matches: OperationMatch<I, O>[];
  readonly assessments: OperationImplementationAssessment[];
}

/** The complete, conservative result of resolving one operation requirement. */
export type OperationRequirementResolution<I = unknown, O = unknown> =
  | {
      readonly status: "available";
      readonly match: OperationMatch<I, O>;
    }
  | {
      readonly status: "ambiguous";
      /** Exactly the equally preferred matches the application must choose between. */
      readonly matches: OperationMatch<I, O>[];
    }
  | {
      readonly status: "unavailable";
      readonly assessments: OperationImplementationAssessment[];
    };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("operation requirement matching was cancelled", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

async function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
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

function makeMatch<I, O>(
  requirement: OperationRequirement<I, O>,
  implementation: OperationImplementation,
  canonicalOperation: string,
  knownContextRequirements: ContextRequiredDetails | null,
): OperationMatch<I, O> {
  return {
    requirement,
    implementation,
    canonicalOperation,
    knownContextRequirements,
    invoke(options?: InvokeOptions): Invocation<I, O> {
      return implementation.invoker.invoke(
        implementation.interface,
        requirement.signature,
        options,
      );
    },
    prepare(options?: InvokeOptions): Promise<ContextRequiredDetails | null> {
      return implementation.invoker.prepareOperation(
        implementation.interface,
        requirement.signature.key,
        options,
      );
    },
  };
}

/**
 * Finds every compatible, invocable match for one operation requirement.
 *
 * Matching is deliberately conservative:
 *
 * 1. the required identifier must correspond by key or alias;
 * 2. its schemas must satisfy the reference comparison profile;
 * 3. the supplied operation invoker must be able to resolve a concrete
 *    binding without side effects.
 *
 * The returned matches are ordered by caller-owned preference, but this
 * function selects nothing. Applications whose operation semantics aggregate,
 * fan out, race, or fall through consume the matches according to their own
 * policy.
 *
 * The function owns no registry and performs no invocation. Applications call
 * it again whenever their interface/delegate state changes; a UI adapter can
 * render its own transient `resolving` state while this promise is pending.
 *
 * @deprecated Use `CompositionSession.inspect` or `CompositionSession.explain`.
 */
export async function matchOperationRequirement<I = unknown, O = unknown>(
  requirement: OperationRequirement<I, O>,
  implementations: readonly OperationImplementation[],
  options?: OperationRequirementMatchOptions,
): Promise<OperationRequirementMatches<I, O>> {
  const assessments: OperationImplementationAssessment[] = [];
  const matches: Array<{
    preference: number;
    index: number;
    match: OperationMatch<I, O>;
  }> = [];

  for (const [index, implementation] of implementations.entries()) {
    throwIfAborted(options?.signal);

    if (!implementation?.interface) {
      assessments.push({
        implementation,
        issues: [],
        reason: "operation implementation interface is required",
      });
      continue;
    }
    if (
      !implementation.invoker ||
      typeof implementation.invoker.prepareOperation !== "function" ||
      typeof implementation.invoker.invoke !== "function"
    ) {
      assessments.push({
        implementation,
        issues: [],
        reason: "operation implementation invoker is required",
      });
      continue;
    }

    const preference = implementation.preference ?? 0;
    if (!Number.isFinite(preference)) {
      assessments.push({
        implementation,
        issues: [],
        reason: "operation implementation preference must be a finite number",
      });
      continue;
    }

    // A requirement taken directly from the implementation's own interface is
    // definitionally the same operation contract. Running the conservative
    // cross-document comparison profile in this identity case can only lose
    // information: the profile intentionally declines schema keywords it
    // cannot prove across independently authored documents (for example,
    // `pattern`), even though no comparison is needed here.
    const issues = requirement.interface === implementation.interface
      ? []
      : await checkOperationCompatibility(
          requirement.interface,
          requirement.signature.key,
          implementation.interface,
        );
    throwIfAborted(options?.signal);
    if (issues.length > 0) {
      assessments.push({ implementation, issues });
      continue;
    }

    const resolved = resolveOperation(implementation.interface, requirement.signature.key);
    if (!resolved) {
      // Defensive: the compatibility check above reports this as `missing`.
      assessments.push({
        implementation,
        issues: [],
        reason: "operation correspondence disappeared during resolution",
      });
      continue;
    }

    try {
      const knownContextRequirements = await abortable(
        implementation.invoker.prepareOperation(
          implementation.interface,
          requirement.signature.key,
          { signal: options?.signal },
        ),
        options?.signal,
      );
      matches.push({
        preference,
        index,
        match: makeMatch(
          requirement,
          implementation,
          resolved.key,
          knownContextRequirements,
        ),
      });
    } catch (error: unknown) {
      if (options?.signal?.aborted) throw abortReason(options.signal);
      assessments.push({
        implementation,
        issues: [],
        reason: errorMessage(error),
      });
    }
  }

  matches.sort((a, b) => b.preference - a.preference || a.index - b.index);
  return {
    matches: matches.map(candidate => candidate.match),
    assessments,
  };
}

/**
 * Resolves one operation requirement for route-to-one use.
 *
 * This convenience applies only caller-owned preference: a unique highest
 * match is available, no matches is unavailable, and an equal highest tie is
 * ambiguous. It never uses input order, interface name, binding order, or
 * invoker registration order as a hidden election. Applications with
 * aggregate/fan-out/race/fallback semantics use
 * {@link matchOperationRequirement} directly.
 *
 * @deprecated Use `CompositionSession.resolve`.
 */
export async function resolveOperationRequirement<I = unknown, O = unknown>(
  requirement: OperationRequirement<I, O>,
  implementations: readonly OperationImplementation[],
  options?: OperationRequirementMatchOptions,
): Promise<OperationRequirementResolution<I, O>> {
  const result = await matchOperationRequirement(
    requirement,
    implementations,
    options,
  );
  if (result.matches.length === 0) {
    return { status: "unavailable", assessments: result.assessments };
  }

  const highest = result.matches[0]!.implementation.preference ?? 0;
  const preferred = result.matches.filter(
    match => (match.implementation.preference ?? 0) === highest,
  );

  if (preferred.length !== 1) {
    return { status: "ambiguous", matches: preferred };
  }
  return { status: "available", match: preferred[0]! };
}

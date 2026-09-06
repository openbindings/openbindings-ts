import type { CompatibilityIssue } from "@openbindings/compare";
import { checkOperationCompatibility } from "@openbindings/compare";
import type {
  PreparedInterface,
  PreparedOperationDescriptor,
} from "@openbindings/core";

/** Portable identifier for the first SDK reference composition policy. */
export const REFERENCE_COMPOSITION_POLICY_ID = "openbindings.reference-composition@1";

export type ContractEvidenceVerdict =
  | "compatible"
  | "incompatible"
  | "indeterminate";

export interface OperationCorrespondence {
  readonly identifier: string;
  readonly requiredOperation: PreparedOperationDescriptor;
  readonly providerOperation: PreparedOperationDescriptor;
}

export interface ContractEvidence {
  readonly verdict: ContractEvidenceVerdict;
  readonly method: "exact" | "directional-profile";
  readonly issues: readonly CompatibilityIssue[];
  readonly detail?: string;
}

export interface ProviderPolicyCandidate {
  readonly providerKey: string;
  readonly preference: number;
}

export type ProviderPolicySelection<T extends ProviderPolicyCandidate> =
  | { readonly status: "selected"; readonly provider: T }
  | { readonly status: "ambiguous"; readonly providers: readonly T[] }
  | { readonly status: "unavailable" };

export interface RealizationPolicyCandidate {
  readonly bindingKey: string;
}

export type RealizationSelector<T extends RealizationPolicyCandidate> = (
  realizations: readonly T[],
) => string | undefined;

export type RealizationPolicySelection<T extends RealizationPolicyCandidate> =
  | { readonly status: "selected"; readonly realization: T }
  | { readonly status: "ambiguous"; readonly realizations: readonly T[] }
  | { readonly status: "unavailable"; readonly detail?: string };

/**
 * The policy decisions composition needs, separate from Core document rules.
 * A policy never creates realizations and therefore cannot forge their OBI
 * identity.
 */
export interface CompositionPolicy {
  readonly id: string;
  /**
   * Orders provider groups for static inspection. A group is an election
   * equivalence class; resolution proceeds to the next group only when the
   * current group has no eligible provider. Exhaustive `inspect` ignores this
   * plan and always evaluates every provider.
   */
  providerInspectionGroups<T extends ProviderPolicyCandidate>(
    candidates: readonly T[],
  ): readonly (readonly T[])[];
  correspondences(
    requiredOperation: PreparedOperationDescriptor,
    provider: PreparedInterface,
  ): readonly OperationCorrespondence[];
  assessContract(
    required: PreparedInterface,
    correspondence: OperationCorrespondence,
    provider: PreparedInterface,
  ): Promise<ContractEvidence>;
  selectProvider<T extends ProviderPolicyCandidate>(
    candidates: readonly T[],
  ): ProviderPolicySelection<T>;
  selectRealization<T extends RealizationPolicyCandidate>(
    candidates: readonly T[],
    selector?: RealizationSelector<T>,
  ): RealizationPolicySelection<T>;
}

function referenceProviderInspectionGroups<T extends ProviderPolicyCandidate>(
  candidates: readonly T[],
): readonly (readonly T[])[] {
  const ordered = [...candidates].sort((left, right) =>
    right.preference - left.preference ||
    (left.providerKey < right.providerKey ? -1 : left.providerKey > right.providerKey ? 1 : 0),
  );
  const groups: T[][] = [];
  for (const candidate of ordered) {
    const group = groups.at(-1);
    if (group?.[0]?.preference === candidate.preference) group.push(candidate);
    else groups.push([candidate]);
  }
  return Object.freeze(groups.map(group => Object.freeze(group)));
}

function referenceCorrespondences(
  requiredOperation: PreparedOperationDescriptor,
  provider: PreparedInterface,
): readonly OperationCorrespondence[] {
  const byCanonical = new Map<string, OperationCorrespondence>();
  for (const identifier of requiredOperation.identifiers) {
    const offered = provider.operation(identifier);
    if (!offered || byCanonical.has(offered.canonicalKey)) continue;
    byCanonical.set(offered.canonicalKey, Object.freeze({
      identifier,
      requiredOperation,
      providerOperation: offered,
    }));
  }
  return Object.freeze(
    [...byCanonical.values()].sort((left, right) =>
      left.providerOperation.canonicalKey < right.providerOperation.canonicalKey ? -1 :
      left.providerOperation.canonicalKey > right.providerOperation.canonicalKey ? 1 :
      left.identifier < right.identifier ? -1 : left.identifier > right.identifier ? 1 : 0,
    ),
  );
}

function profileCouldNotDecide(issues: readonly CompatibilityIssue[]): boolean {
  return issues.some(issue => issue.detail?.includes("schema check failed:") === true);
}

async function referenceContractEvidence(
  required: PreparedInterface,
  correspondence: OperationCorrespondence,
  provider: PreparedInterface,
): Promise<ContractEvidence> {
  const requiredContract = await required.boundaryContract(
    correspondence.requiredOperation.canonicalKey,
  )!;
  const providerContract = await provider.boundaryContract(
    correspondence.providerOperation.canonicalKey,
  )!;
  if (
    requiredContract.complete &&
    providerContract.complete &&
    requiredContract.revision === providerContract.revision &&
    requiredContract.canonical === providerContract.canonical
  ) {
    return Object.freeze({
      verdict: "compatible",
      method: "exact",
      issues: Object.freeze([]),
    });
  }

  const issues = Object.freeze(await checkOperationCompatibility(
    required.interfaceSnapshot,
    correspondence.identifier,
    provider.interfaceSnapshot,
  ));
  if (profileCouldNotDecide(issues)) {
    return Object.freeze({
      verdict: "indeterminate",
      method: "directional-profile",
      issues,
      detail: "the directional schema profile could not decide this contract",
    });
  }
  return Object.freeze({
    verdict: issues.length === 0 ? "compatible" : "incompatible",
    method: "directional-profile",
    issues,
  });
}

function referenceProviderSelection<T extends ProviderPolicyCandidate>(
  candidates: readonly T[],
): ProviderPolicySelection<T> {
  if (candidates.length === 0) return Object.freeze({ status: "unavailable" });
  let highest = -Infinity;
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.preference)) {
      throw new TypeError(
        `openbindings: provider ${JSON.stringify(candidate.providerKey)} preference must be finite`,
      );
    }
    highest = Math.max(highest, candidate.preference);
  }
  const preferred = candidates
    .filter(candidate => candidate.preference === highest)
    .sort((left, right) =>
      left.providerKey < right.providerKey ? -1 : left.providerKey > right.providerKey ? 1 : 0,
    );
  if (preferred.length !== 1) {
    return Object.freeze({
      status: "ambiguous",
      providers: Object.freeze(preferred),
    });
  }
  return Object.freeze({ status: "selected", provider: preferred[0]! });
}

function referenceRealizationSelection<T extends RealizationPolicyCandidate>(
  candidates: readonly T[],
  selector?: RealizationSelector<T>,
): RealizationPolicySelection<T> {
  const ordered = [...candidates].sort((left, right) =>
    left.bindingKey < right.bindingKey ? -1 : left.bindingKey > right.bindingKey ? 1 : 0,
  );
  if (selector) {
    const selectedKey = selector(Object.freeze(ordered));
    if (selectedKey === undefined) {
      return Object.freeze({
        status: "unavailable",
        detail: "the provider realization selector declined every realization",
      });
    }
    const selected = ordered.find(candidate => candidate.bindingKey === selectedKey);
    if (!selected) {
      return Object.freeze({
        status: "unavailable",
        detail: `the provider realization selector returned unknown binding ${JSON.stringify(selectedKey)}`,
      });
    }
    return Object.freeze({ status: "selected", realization: selected });
  }
  if (ordered.length === 0) return Object.freeze({ status: "unavailable" });
  if (ordered.length !== 1) {
    return Object.freeze({
      status: "ambiguous",
      realizations: Object.freeze(ordered),
    });
  }
  return Object.freeze({ status: "selected", realization: ordered[0]! });
}

/**
 * Explicit, versioned SDK convention implementing the 0.2 reference policy.
 * It is not an OpenBindings Core semantic.
 */
export const referenceCompositionPolicy: CompositionPolicy = Object.freeze({
  id: REFERENCE_COMPOSITION_POLICY_ID,
  providerInspectionGroups: referenceProviderInspectionGroups,
  correspondences: referenceCorrespondences,
  assessContract: referenceContractEvidence,
  selectProvider: referenceProviderSelection,
  selectRealization: referenceRealizationSelection,
});

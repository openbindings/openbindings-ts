import type { PreparedDependencyDescriptor, PreparedInterface } from "@openbindings/core";
import { DependencyNotFoundError } from "@openbindings/core";
import type { InvokeOptions } from "./invoker-types.js";
import type { PreparedPreflightOptions } from "./operation-invoker.js";
import { InvocationError, type ContextRequiredDetails, type Invocation } from "./invocation.js";
import type { DependencySignature } from "./dependency.js";
import type {
  CompositionPolicy,
  ContractEvidence,
  OperationCorrespondence,
  ProviderPolicyCandidate,
} from "./composition-policy.js";
import { referenceCompositionPolicy } from "./composition-policy.js";
import type {
  PreparedProvider,
  PreparedRealization,
  PreparedRealizationDescriptor,
} from "./prepared-provider.js";

export interface ProviderRegistration {
  readonly provider: PreparedProvider;
  /** Finite, application-owned policy input. Defaults to zero. */
  readonly preference?: number;
}

export interface CompositionSessionOptions {
  readonly consumer: PreparedInterface;
  readonly providers: readonly ProviderRegistration[];
  readonly policy?: CompositionPolicy;
}

export interface CompositionAssessment {
  readonly code:
    | "provider_disposed"
    | "operation_missing"
    | "contract_incompatible"
    | "contract_indeterminate"
    | "operation_unbound"
    | "binding_spec_disallowed"
    | "binding_spec_unsupported"
    | "realization_selection_declined"
    | "realization_closure_failed";
  readonly providerKey?: string;
  readonly operationKey?: string;
  readonly bindingKey?: string;
  readonly bindingSpec?: string;
  readonly evidence?: ContractEvidence;
  readonly failure?: { readonly code: string; readonly data?: unknown };
  readonly detail?: string;
}

export interface InspectedRealization {
  readonly providerKey: string;
  readonly providerOperationKey: string;
  readonly correspondenceIdentifier: string;
  readonly bindingKey: string;
  readonly sourceKey: string;
  readonly bindingSpec: string;
  readonly selector: string;
  readonly evidence: ContractEvidence;
}

export interface InspectedProvider extends ProviderPolicyCandidate {
  readonly realizations: readonly InspectedRealization[];
}

export interface DependencyInspection {
  readonly sessionRevision: string;
  readonly policyId: string;
  readonly dependencyKey: string;
  readonly requiredOperationKey: string;
  readonly providers: readonly InspectedProvider[];
  readonly assessments: readonly CompositionAssessment[];
}

export interface CompositionAmbiguity {
  readonly stage: "provider" | "realization";
  readonly providers: readonly string[];
  readonly realizations: readonly InspectedRealization[];
}

export type DependencyRouteResolution<I = unknown, O = unknown> =
  | { readonly status: "available"; readonly route: PreparedDependencyRoute<I, O> }
  | { readonly status: "ambiguous"; readonly ambiguity: CompositionAmbiguity }
  | { readonly status: "unavailable"; readonly assessments: readonly CompositionAssessment[] };

interface EligibleRealization {
  readonly provider: PreparedProvider;
  readonly descriptor: PreparedRealizationDescriptor;
  readonly correspondence: OperationCorrespondence;
  readonly evidence: ContractEvidence;
}

interface EligibleProvider {
  readonly provider: PreparedProvider;
  readonly providerKey: string;
  readonly preference: number;
  readonly realizations: readonly EligibleRealization[];
}

/** Retained, statically verified route for one named consumer dependency. */
export class PreparedDependencyRoute<I = unknown, O = unknown> {
  readonly #realization: PreparedRealization<I, O>;

  readonly policyId: string;
  readonly consumerRevision: string;
  readonly dependencyKey: string;
  readonly requiredOperationKey: string;
  readonly providerKey: string;
  readonly providerOperationKey: string;
  readonly correspondenceIdentifier: string;
  readonly bindingKey: string;
  readonly sourceKey: string;
  readonly bindingSpec: string;

  private constructor(
    policyId: string,
    consumer: PreparedInterface,
    dependency: PreparedDependencyDescriptor,
    eligible: EligibleRealization,
    realization: PreparedRealization<I, O>,
  ) {
    this.#realization = realization;
    this.policyId = policyId;
    this.consumerRevision = consumer.revision;
    this.dependencyKey = dependency.key;
    this.requiredOperationKey = dependency.operation.canonicalKey;
    this.providerKey = eligible.provider.key;
    this.providerOperationKey = eligible.correspondence.providerOperation.canonicalKey;
    this.correspondenceIdentifier = eligible.correspondence.identifier;
    this.bindingKey = eligible.descriptor.bindingKey;
    this.sourceKey = eligible.descriptor.sourceKey;
    this.bindingSpec = eligible.descriptor.bindingSpec;
    Object.freeze(this);
  }

  invoke(options?: Omit<InvokeOptions, "bindingKey">): Invocation<I, O> {
    return this.#realization.invoke(options);
  }

  preflight(
    options?: PreparedPreflightOptions,
  ): Promise<ContextRequiredDetails | null> {
    return this.#realization.preflight(options);
  }

  /** @internal */
  static create<I, O>(
    policyId: string,
    consumer: PreparedInterface,
    dependency: PreparedDependencyDescriptor,
    eligible: EligibleRealization,
    realization: PreparedRealization<I, O>,
  ): PreparedDependencyRoute<I, O> {
    return new PreparedDependencyRoute(
      policyId,
      consumer,
      dependency,
      eligible,
      realization,
    );
  }
}

function dependencyKey(value: string | { readonly key: string }): string {
  return typeof value === "string" ? value : value.key;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("composition was cancelled", "AbortError");
}

/**
 * Stops composition from waiting on application policy work that does not
 * itself observe AbortSignal. The underlying promise is still allowed to
 * settle, but its result can no longer be published by this session call.
 */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      try {
        throwIfAborted(signal);
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      value => {
        cleanup();
        resolve(value);
      },
      error => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function inspected(eligible: EligibleRealization): InspectedRealization {
  return Object.freeze({
    providerKey: eligible.provider.key,
    providerOperationKey: eligible.correspondence.providerOperation.canonicalKey,
    correspondenceIdentifier: eligible.correspondence.identifier,
    bindingKey: eligible.descriptor.bindingKey,
    sourceKey: eligible.descriptor.sourceKey,
    bindingSpec: eligible.descriptor.bindingSpec,
    selector: eligible.descriptor.selector,
    evidence: eligible.evidence,
  });
}

function structuredFailure(error: unknown): { code: string; data?: unknown } | undefined {
  return error instanceof InvocationError
    ? Object.freeze({
        code: error.code,
        ...(error.data === undefined ? {} : { data: error.data }),
      })
    : undefined;
}

/**
 * Application-scoped composition over immutable consumer/provider snapshots.
 */
export class CompositionSession {
  readonly consumer: PreparedInterface;
  readonly policy: CompositionPolicy;
  readonly revision: string;
  readonly #registrations: readonly Required<Pick<ProviderRegistration, "provider"> & { preference: number }>[];

  constructor(options: CompositionSessionOptions) {
    this.consumer = options.consumer;
    this.policy = options.policy ?? referenceCompositionPolicy;
    const seen = new Set<string>();
    this.#registrations = Object.freeze(options.providers.map(registration => {
      const key = registration.provider.key;
      if (seen.has(key)) {
        throw new TypeError(`openbindings: duplicate prepared provider key: ${JSON.stringify(key)}`);
      }
      seen.add(key);
      const preference = registration.preference ?? 0;
      if (!Number.isFinite(preference)) {
        throw new TypeError(`openbindings: provider ${JSON.stringify(key)} preference must be finite`);
      }
      return Object.freeze({ provider: registration.provider, preference });
    }));
    this.revision = [
      this.policy.id,
      this.consumer.revision,
      ...this.#registrations
        .map(({ provider, preference }) => `${provider.key}:${provider.interface.revision}:${preference}`)
        .sort(),
    ].join("|");
    Object.freeze(this);
  }

  async inspect(
    dependency: string | DependencySignature,
    options?: { readonly signal?: AbortSignal },
  ): Promise<DependencyInspection> {
    const key = dependencyKey(dependency);
    const required = this.consumer.dependency(key);
    if (!required) {
      throw new DependencyNotFoundError(key, [...this.consumer.dependencyKeys()]);
    }
    throwIfAborted(options?.signal);
    const evaluated = await Promise.all(
      this.#registrations.map(registration =>
        this.#inspectProvider(required, registration, options?.signal),
      ),
    );
    throwIfAborted(options?.signal);
    const providers = evaluated
      .flatMap(result => result.provider ? [result.provider] : [])
      .sort((left, right) =>
        right.preference - left.preference ||
        (left.providerKey < right.providerKey ? -1 : left.providerKey > right.providerKey ? 1 : 0),
      );
    const assessments = evaluated.flatMap(result => result.assessments);
    return Object.freeze({
      sessionRevision: this.revision,
      policyId: this.policy.id,
      dependencyKey: key,
      requiredOperationKey: required.operation.canonicalKey,
      providers: Object.freeze(providers.map(provider => Object.freeze({
        providerKey: provider.providerKey,
        preference: provider.preference,
        realizations: Object.freeze(provider.realizations.map(inspected)),
      }))),
      assessments: Object.freeze(assessments),
    });
  }

  async resolve<I = unknown, O = unknown>(
    dependency: string | DependencySignature<I, O>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<DependencyRouteResolution<I, O>> {
    const key = dependencyKey(dependency);
    const required = this.consumer.dependency(key);
    if (!required) {
      throw new DependencyNotFoundError(key, [...this.consumer.dependencyKeys()]);
    }
    const registrationsByKey = new Map(
      this.#registrations.map(registration => [registration.provider.key, registration]),
    );
    const inspectionPlan = this.policy.providerInspectionGroups(
      this.#registrations.map(registration => Object.freeze({
        providerKey: registration.provider.key,
        preference: registration.preference,
      })),
    );
    const plannedKeys = new Set<string>();
    for (const candidate of inspectionPlan.flat()) {
      if (plannedKeys.has(candidate.providerKey)) {
        throw new TypeError(
          `openbindings: composition policy planned provider ${JSON.stringify(candidate.providerKey)} more than once`,
        );
      }
      if (!registrationsByKey.has(candidate.providerKey)) {
        throw new TypeError(
          `openbindings: composition policy planned unknown provider ${JSON.stringify(candidate.providerKey)}`,
        );
      }
      plannedKeys.add(candidate.providerKey);
    }
    if (plannedKeys.size !== this.#registrations.length) {
      throw new TypeError("openbindings: composition policy provider inspection plan omitted a provider");
    }
    const assessments: CompositionAssessment[] = [];
    let selectedProvider: EligibleProvider | undefined;

    for (const group of inspectionPlan) {
      const registrations = group.map(candidate => {
        return registrationsByKey.get(candidate.providerKey)!;
      });
      const evaluated = await Promise.all(
        registrations.map(registration =>
          this.#inspectProvider(required, registration, options?.signal),
        ),
      );
      throwIfAborted(options?.signal);
      assessments.push(...evaluated.flatMap(result => result.assessments));
      const eligible = evaluated.flatMap(result => result.provider ? [result.provider] : []);
      if (eligible.length === 0) continue;

      const providerSelection = this.policy.selectProvider(eligible.map(provider => Object.freeze({
        providerKey: provider.providerKey,
        preference: provider.preference,
      })));
      if (!providerSelection || !["selected", "ambiguous", "unavailable"].includes(providerSelection.status)) {
        throw new Error("composition policy returned an invalid provider selection status");
      }
      if (providerSelection.status === "selected" && !eligible.some(candidate => candidate.providerKey === providerSelection.provider?.providerKey)) {
        throw new Error("composition policy selected an unknown provider");
      }
      if (providerSelection.status === "ambiguous") {
        const choices = providerSelection.providers;
        if (!Array.isArray(choices) || choices.length < 2
          || new Set(choices.map((choice: { providerKey?: string } | null) => choice?.providerKey)).size !== choices.length
          || choices.some((choice: { providerKey?: string } | null) => !eligible.some(candidate => candidate.providerKey === choice?.providerKey))) {
          throw new Error("composition policy returned invalid provider ambiguity");
        }
      }
      if (providerSelection.status === "unavailable") continue;
      if (providerSelection.status === "ambiguous") {
        const providerKeys = providerSelection.providers.map(provider => provider.providerKey);
        const tied = eligible.filter(provider => providerKeys.includes(provider.providerKey));
        return Object.freeze({
          status: "ambiguous",
          ambiguity: Object.freeze({
            stage: "provider",
            providers: Object.freeze([...providerKeys].sort()),
            realizations: Object.freeze(tied.flatMap(provider => provider.realizations.map(inspected))),
          }),
        });
      }
      selectedProvider = eligible.find(
        provider => provider.providerKey === providerSelection.provider.providerKey,
      );
      if (selectedProvider) break;
    }

    if (!selectedProvider) {
      return Object.freeze({ status: "unavailable", assessments: Object.freeze(assessments) });
    }
    const descriptors = selectedProvider.realizations.map(candidate => candidate.descriptor);
    const realizationSelection = this.policy.selectRealization(
      descriptors,
      selectedProvider.provider.selectRealization,
    );
    if (!realizationSelection || !["selected", "ambiguous", "unavailable"].includes(realizationSelection.status)) {
      throw new Error("composition policy returned an invalid realization selection status");
    }
    if (realizationSelection.status === "selected" && !selectedProvider.realizations.some(candidate => candidate.descriptor.bindingKey === realizationSelection.realization?.bindingKey)) {
      throw new Error("composition policy selected an unknown realization");
    }
    if (realizationSelection.status === "ambiguous") {
      const choices = realizationSelection.realizations;
      if (!Array.isArray(choices) || choices.length < 2
        || new Set(choices.map((choice: { bindingKey?: string } | null) => choice?.bindingKey)).size !== choices.length
        || choices.some((choice: { bindingKey?: string } | null) => !selectedProvider.realizations.some(candidate => candidate.descriptor.bindingKey === choice?.bindingKey))) {
        throw new Error("composition policy returned invalid realization ambiguity");
      }
    }
    if (realizationSelection.status === "ambiguous") {
      const keys = new Set(realizationSelection.realizations.map(item => item.bindingKey));
      return Object.freeze({
        status: "ambiguous",
        ambiguity: Object.freeze({
          stage: "realization",
          providers: Object.freeze([selectedProvider.providerKey]),
          realizations: Object.freeze(
            selectedProvider.realizations.filter(item => keys.has(item.descriptor.bindingKey)).map(inspected),
          ),
        }),
      });
    }
    if (realizationSelection.status === "unavailable") {
      return Object.freeze({
        status: "unavailable",
        assessments: Object.freeze([
          ...assessments,
          Object.freeze({
            code: "realization_selection_declined" as const,
            providerKey: selectedProvider.providerKey,
            detail: realizationSelection.detail,
          }),
        ]),
      });
    }

    const selected = selectedProvider.realizations.find(
      candidate => candidate.descriptor.bindingKey === realizationSelection.realization.bindingKey,
    )!;
    try {
      const realization = selected.provider.closeRealization<I, O>(selected.descriptor.bindingKey);
      return Object.freeze({
        status: "available",
        route: PreparedDependencyRoute.create(
          this.policy.id,
          this.consumer,
          required,
          selected,
          realization,
        ),
      });
    } catch (error: unknown) {
      return Object.freeze({
        status: "unavailable",
        assessments: Object.freeze([
          ...assessments,
          Object.freeze({
            code: "realization_closure_failed" as const,
            providerKey: selected.provider.key,
            operationKey: selected.correspondence.providerOperation.canonicalKey,
            bindingKey: selected.descriptor.bindingKey,
            bindingSpec: selected.descriptor.bindingSpec,
            failure: structuredFailure(error),
            detail: error instanceof Error ? error.message : String(error),
          }),
        ]),
      });
    }
  }

  async #inspectProvider(
    dependency: PreparedDependencyDescriptor,
    registration: { readonly provider: PreparedProvider; readonly preference: number },
    signal?: AbortSignal,
  ): Promise<{
    provider?: EligibleProvider;
    assessments: readonly CompositionAssessment[];
  }> {
    const provider = registration.provider;
    if (provider.disposed) {
      return {
        assessments: [Object.freeze({
          code: "provider_disposed",
          providerKey: provider.key,
        })],
      };
    }
    throwIfAborted(signal);
    const correspondences = this.policy.correspondences(
      dependency.operation,
      provider.interface,
    );
    if (correspondences.length === 0) {
      return {
        assessments: [Object.freeze({
          code: "operation_missing",
          providerKey: provider.key,
          operationKey: dependency.operation.canonicalKey,
        })],
      };
    }

    const assessments: CompositionAssessment[] = [];
    const realizations = new Map<string, EligibleRealization>();
    for (const correspondence of correspondences) {
      throwIfAborted(signal);
      const evidence = await abortable(
        this.policy.assessContract(
          this.consumer,
          correspondence,
          provider.interface,
        ),
        signal,
      );
      throwIfAborted(signal);
      if (evidence.verdict !== "compatible") {
        assessments.push(Object.freeze({
          code: evidence.verdict === "indeterminate"
            ? "contract_indeterminate"
            : "contract_incompatible",
          providerKey: provider.key,
          operationKey: correspondence.providerOperation.canonicalKey,
          evidence,
        }));
        continue;
      }

      const descriptors = provider.realizationsForOperation(
        correspondence.providerOperation.canonicalKey,
      );
      if (descriptors.length === 0) {
        assessments.push(Object.freeze({
          code: "operation_unbound",
          providerKey: provider.key,
          operationKey: correspondence.providerOperation.canonicalKey,
        }));
        continue;
      }
      for (const descriptor of descriptors) {
        if (
          dependency.allowedBindingSpecs !== undefined &&
          !dependency.allowsBindingSpec(descriptor.bindingSpec)
        ) {
          assessments.push(Object.freeze({
            code: "binding_spec_disallowed",
            providerKey: provider.key,
            operationKey: descriptor.operationKey,
            bindingKey: descriptor.bindingKey,
            bindingSpec: descriptor.bindingSpec,
          }));
          continue;
        }
        if (!descriptor.supported) {
          assessments.push(Object.freeze({
            code: "binding_spec_unsupported",
            providerKey: provider.key,
            operationKey: descriptor.operationKey,
            bindingKey: descriptor.bindingKey,
            bindingSpec: descriptor.bindingSpec,
          }));
          continue;
        }
        realizations.set(descriptor.bindingKey, Object.freeze({
          provider,
          descriptor,
          correspondence,
          evidence,
        }));
      }
    }
    if (realizations.size === 0) return { assessments: Object.freeze(assessments) };
    return {
      provider: Object.freeze({
        provider,
        providerKey: provider.key,
        preference: registration.preference,
        realizations: Object.freeze([...realizations.values()].sort((left, right) =>
          left.descriptor.bindingKey < right.descriptor.bindingKey ? -1 :
          left.descriptor.bindingKey > right.descriptor.bindingKey ? 1 : 0,
        )),
      }),
      assessments: Object.freeze(assessments),
    };
  }
}

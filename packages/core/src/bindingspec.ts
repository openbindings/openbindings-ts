/** Describes a binding specification supported by an invoker, by exact identifier. */
export interface BindingSpecInfo {
  bindingSpec: string;
  description?: string;
}

/** Authoritative support verdict for an exact, opaque binding-specification identifier. */
export interface BindingSpecVerdict {
  bindingSpec: string;
  supported: boolean;
}

/**
 * Checks exact binding-specification support while preserving first-occurrence
 * order and removing duplicate requests. An empty request returns an empty,
 * non-null array.
 */
export function checkBindingSpecs(
  bindingSpecs: readonly string[],
  supported: readonly BindingSpecInfo[],
): BindingSpecVerdict[] {
  const warranted = new Set(supported.map(({ bindingSpec }) => bindingSpec));
  const seen = new Set<string>();
  const verdicts: BindingSpecVerdict[] = [];
  for (const bindingSpec of bindingSpecs) {
    if (seen.has(bindingSpec)) continue;
    seen.add(bindingSpec);
    verdicts.push({ bindingSpec, supported: warranted.has(bindingSpec) });
  }
  return verdicts;
}

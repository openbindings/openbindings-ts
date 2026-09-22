/** Evidence states and conclusion logic defined by core §10.5 / OBI-T-17. */
export type RuleEvidenceStatus =
  | "satisfied"
  | "violated"
  | "inconclusive"
  | "not-applicable";

export type ConformanceConclusion =
  | "conformant"
  | "non-conformant"
  | "conformance-undetermined";

/**
 * A validator's conformance conclusion and the rule identifiers OBI-T-17
 * requires it to report.
 */
export interface ValidationReport {
  conclusion: ConformanceConclusion;
  violated: string[];
  inconclusive: string[];
}

/**
 * Applies OBI-T-17's truth conditions to a complete map of document-rule
 * evidence. The caller supplies every applicable rule; absence is not itself
 * an evidence status.
 *
 * A violation is decisive even when other rules remain inconclusive. Without a
 * violation, any inconclusive applicable rule makes the result undetermined;
 * otherwise it is conformant. Rule identifiers are sorted for deterministic
 * SDK output; the core specification requires their identity, not this order.
 * An unrecognized status received from untyped JavaScript is treated
 * conservatively as inconclusive rather than allowing malformed evidence to
 * produce a conformant conclusion.
 */
export function concludeConformance(
  evidence: Readonly<Record<string, RuleEvidenceStatus>>,
): ValidationReport {
  const violated: string[] = [];
  const inconclusive: string[] = [];
  for (const [rule, status] of Object.entries(evidence)) {
    if (status === "violated") violated.push(rule);
    if (
      status === "inconclusive" ||
      !["satisfied", "violated", "not-applicable"].includes(status)
    ) {
      inconclusive.push(rule);
    }
  }
  violated.sort();
  inconclusive.sort();
  const conclusion: ConformanceConclusion =
    violated.length > 0
      ? "non-conformant"
      : inconclusive.length > 0
        ? "conformance-undetermined"
        : "conformant";
  return { conclusion, violated, inconclusive };
}

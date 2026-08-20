/** Evidence states and conclusion logic defined by core §10.5 / OBI-T-17. */
export type RuleEvidenceStatus =
  | "satisfied"
  | "violated"
  | "unverified"
  | "not-applicable";

export type VerificationConclusion =
  | "conformant"
  | "non-conformant"
  | "conformance-undetermined";

export interface VerificationReport {
  conclusion: VerificationConclusion;
  violated: string[];
  unverified: string[];
}

/**
 * Applies OBI-T-17's truth conditions to a complete map of document-rule
 * evidence. The caller supplies every applicable rule; absence is not itself
 * an evidence status.
 *
 * A violation is decisive even when other rules remain unverified. Without a
 * violation, any unverified applicable rule makes the result undetermined;
 * otherwise it is conformant. Rule identifiers are sorted for deterministic
 * SDK output; the core specification requires their identity, not this order.
 * An unrecognized status received from untyped JavaScript is treated
 * conservatively as unverified rather than allowing malformed evidence to
 * produce a conformant conclusion.
 */
export function concludeVerification(
  evidence: Readonly<Record<string, RuleEvidenceStatus>>,
): VerificationReport {
  const violated: string[] = [];
  const unverified: string[] = [];
  for (const [rule, status] of Object.entries(evidence)) {
    if (status === "violated") violated.push(rule);
    if (
      status === "unverified" ||
      !["satisfied", "violated", "not-applicable"].includes(status)
    ) {
      unverified.push(rule);
    }
  }
  violated.sort();
  unverified.sort();
  const conclusion: VerificationConclusion =
    violated.length > 0
      ? "non-conformant"
      : unverified.length > 0
        ? "conformance-undetermined"
        : "conformant";
  return { conclusion, violated, unverified };
}

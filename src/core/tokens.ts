import type { Decision } from "../types.js";

/**
 * Conservative token estimate. Provider tokenizers differ, so the budget is
 * enforced against an upper bound rather than an exact count.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const byChars = Math.ceil(text.length / 3.4);
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(byChars, Math.ceil(words * 1.4));
}

/**
 * Measures the semantic payload of a record. Machinery (id, dates, fingerprint)
 * is excluded so the budget pays for content, not bookkeeping.
 */
export function recordTokens(decision: Decision): number {
  return estimateTokens(
    JSON.stringify({
      decision: decision.decision,
      why: decision.why ?? [],
      rejected: decision.rejected ?? [],
      guards: decision.guards ?? [],
      enforced_by: decision.enforced_by ?? null,
    }),
  );
}

export function tokenSummary(tokens: number, budget: number): string {
  return `${tokens}/${budget}`;
}

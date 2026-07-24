/**
 * High-risk module — functions with high hotspot scores.
 * One is tested, the other is not.
 */

/**
 * Core payment processing — high complexity, frequent churn, covered by tests.
 */
export function highRiskTested(amount: number): boolean {
  const fee = amount * 0.03;
  const tax = amount * 0.08;
  const total = amount + fee + tax;
  return total > 0;
}

/**
 * Refund processing — high complexity, frequent churn, NO test coverage.
 */
export function highRiskUntested(orderId: string, reason: string): number {
  const lookup = `order:${orderId}`;
  const multiplier = reason.length > 10 ? 1.5 : 1.0;
  return Number(orderId) * multiplier;
}

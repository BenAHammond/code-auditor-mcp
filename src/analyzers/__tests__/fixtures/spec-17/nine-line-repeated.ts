/**
 * Spec-17 R8 Fixture 14: nine-line-repeated
 * Report section: R3.2 — Minimum block size 5 → 15
 *
 * A 9-line code pattern repeated twice should produce ZERO findings
 * because it is below the 15-line minimum threshold.
 */

export function calcA(x: number): number {
  const a = x * 2;
  const b = a + 10;
  const c = b / 3;
  return Math.round(c);
}

export function calcB(y: number): number {
  const a = y * 2;
  const b = a + 10;
  const c = b / 3;
  return Math.round(c);
}

/**
 * Spec-17 R8 Fixture 3: exported-undocumented
 * Report section: R1.2 — Default scope is public API surface only
 *
 * Exported function without JSDoc should produce EXACTLY ONE finding,
 * and the message should cite "exported".
 */

export function calculateTotal(price: number, quantity: number, tax: number): number {
  const subtotal = price * quantity;
  const taxAmount = subtotal * tax;
  return subtotal + taxAmount;
}

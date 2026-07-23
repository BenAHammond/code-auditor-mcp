/**
 * Scripts-tree module with an undocumented exported function.
 * Same code as src/demo-module.ts — the profile controls what fires.
 */
export function calculateTotal(items: number[]): number {
  let total = 0;
  for (const item of items) {
    total += item * 1.1;
  }
  return total;
}

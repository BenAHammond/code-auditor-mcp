/**
 * Source-tree module with an undocumented exported function.
 * When requireFunctionDocs is true (default), the documentation analyzer
 * flags this. When a profile sets requireFunctionDocs=false, skip entirely.
 */
export function calculateTotal(items: number[]): number {
  let total = 0;
  for (const item of items) {
    total += item * 1.1;
  }
  return total;
}

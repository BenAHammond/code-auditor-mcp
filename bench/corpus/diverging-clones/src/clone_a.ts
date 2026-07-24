/**
 * Fixture file for diverging-clone detection.
 *
 * This file and clone_b.ts have structurally similar blocks that were
 * once near-identical (similarity ~0.85) but have since diverged across
 * multiple edits — the diverging-clone detection should flag this.
 *
 * The bench runner seeds dry_pair_history with 3 rows simulating
 * similarity declining: 0.85 → 0.78 → 0.68
 * With divergenceThreshold=0.05 and divergenceRuns=2, this triggers
 * dry/diverging-clone at suggestion severity.
 */

export function processOrder(order: { id: number; items: string[] }): string {
  const result: string[] = [];

  // Validate order structure
  if (!order || !order.id) {
    throw new Error('Invalid order');
  }

  // Process each item — this block shares ancestry with clone_b
  const items = order.items ?? [];
  for (const item of items) {
    const sanitized = item.trim().toLowerCase();
    if (sanitized.length > 0) {
      result.push(`[${order.id}] ${sanitized}`);
    }
  }

  // Diverged section: uses different formatting from clone_b
  const formatted = result.join('\n');
  const summary = `[Order #${order.id}] ${items.length} items processed`;
  const response = JSON.stringify({ summary, items: formatted, timestamp: Date.now() });

  return response;
}

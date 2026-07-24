/**
 * Fixture file for diverging-clone detection.
 *
 * This file and clone_a.ts were once near-identical clones but have
 * diverged through different refactors. The bench runner seeds
 * dry_pair_history with declining similarity to simulate this.
 */

export function handleInvoice(invoice: { id: number; items: string[] }): string {
  const result: string[] = [];

  // Validate invoice structure
  if (!invoice || !invoice.id) {
    throw new Error('Invalid invoice');
  }

  // Process each item — this block shares ancestry with clone_a
  const items = invoice.items ?? [];
  for (const item of items) {
    const sanitized = item.trim().toLowerCase();
    if (sanitized.length > 0) {
      result.push(`[${invoice.id}] ${sanitized}`);
    }
  }

  // Diverged section: uses completely different formatting from clone_a
  const summary = `Invoice #${invoice.id} — ${items.length} line(s)`;
  const formatted = result.length > 0
    ? result.map((r, i) => `  ${i + 1}. ${r}`).join('\n')
    : '(empty)';

  return `${summary}\n${formatted}`;
}

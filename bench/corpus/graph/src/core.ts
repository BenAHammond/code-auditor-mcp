// Hub function — called by many modules (high PageRank)
export function calculateTotal(items: number[]): number {
  return items.reduce((sum, item) => sum + item, 0);
}

// Orchestrator — calls hub + module_a + module_b
export function finalizeOrder(order: { items: number[]; weight: number }): number {
  const subtotal = calculateTotal(order.items);
  return subtotal;
}

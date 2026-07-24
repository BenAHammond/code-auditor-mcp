// Bridge function — on shortest paths between module_a and module_b (high betweenness)
export function validateOrder(order: { weight: number; items: number[] }): boolean {
  return order.weight > 0 && order.items.length > 0;
}

// Orchestrator — calls bridge + module_b
export function processAndReport(order: { weight: number; items: number[] }): string {
  const valid = validateOrder(order);
  return valid ? 'valid' : 'invalid';
}

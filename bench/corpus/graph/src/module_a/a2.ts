// Community A — calls module_a/a1 and core hub
export function calculateShipping(order: { weight: number }): number {
  return order.weight * 1.5;
}

export function estimateTotal(order: { items: number[]; weight: number }): number {
  return order.weight + order.items.length;
}

// Community A — intra-module calls, imports from core
export function calculateTax(subtotal: number): number {
  return subtotal * 0.08;
}

export function processModuleA(data: { items: number[] }): number {
  return data.items.length;
}

// Community B — intra-module calls, imports from core
export function processOrder(total: number): number {
  return Math.round(total * 100) / 100;
}

export function handleModuleB(data: { values: number[] }): number {
  return data.values.length;
}

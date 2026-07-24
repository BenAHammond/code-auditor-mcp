// Community C — split across directory boundary, imports from module_b
export function crossModuleOperation(data: { total: number }): string {
  return `Cross: ${data.total}`;
}

export function moduleCOperation(value: number): number {
  return value * 2;
}

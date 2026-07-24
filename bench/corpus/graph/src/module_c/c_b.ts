// Community C — calls c_a internally
export function processModuleC(data: { value: number }): number {
  return data.value;
}

export function handleModuleC(data: { value: number }): string {
  return `Processed: ${data.value}`;
}

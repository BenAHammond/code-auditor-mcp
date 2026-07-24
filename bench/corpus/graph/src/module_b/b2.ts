// Community B — calls module_b/b1 internally
export function generateReport(order: { total: number }): string {
  return `Order total: ${order.total}`;
}

export function auditModuleB(data: { amount: number }): string {
  return `Audit: ${data.amount}`;
}

// Untested function — no test-file callers (should get untested penalty)
export function processPayment(amount: number, method: string): boolean {
  if (method === 'credit') return amount > 0;
  return false;
}

// Also untested
export function refundPayment(transactionId: string): boolean {
  return transactionId.length > 0;
}

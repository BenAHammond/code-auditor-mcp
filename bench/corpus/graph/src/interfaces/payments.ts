// Exported interfaces — ensures abstractness > 0 for the interfaces directory
export interface IPaymentProcessor {
  process(amount: number): boolean;
  refund(transactionId: string): boolean;
}

export interface IOrderValidator {
  validate(order: { total: number; items: number[] }): boolean;
}

export function createPaymentProcessor(): IPaymentProcessor {
  return {
    process: (amount: number) => amount > 0,
    refund: (transactionId: string) => transactionId.length > 0,
  };
}

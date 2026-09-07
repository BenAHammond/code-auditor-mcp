/**
 * Validator functions — use zod for schema validation.
 * These are provenance-detected validators.
 */
import { z } from 'zod';

const orderSchema = z.object({
  id: z.number(),
  data: z.record(z.unknown()),
});

export function validateOrder(data: unknown): boolean {
  const result = orderSchema.safeParse(data);
  return result.success;
}

const paymentSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().length(3),
});

export function validatePayment(data: unknown): boolean {
  const result = paymentSchema.safeParse(data);
  return result.success;
}

/**
 * A non-validator helper that cohabits the zod-importing file.
 * Does NOT use zod — its usedImports won't include 'zod'.
 * Used to verify per-identifier validator detection:
 * a writer reaching only formatHelper (not validateOrder/validatePayment)
 * should still trigger a no-validator-reachable violation.
 */
export function formatHelper(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

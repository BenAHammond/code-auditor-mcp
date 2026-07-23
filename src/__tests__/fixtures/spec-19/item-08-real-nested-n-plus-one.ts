/**
 * Spec-19 item 8 — loop-query TRUE positive (oracle: MUST fire).
 * SELECT inside while loop with per-row child queries.
 * Classic N+1: outer query + per-row inner queries.
 */
import { query } from './db';

interface Order {
  id: string;
  customerId: string;
  total: number;
}

interface Customer {
  id: string;
  name: string;
  tier: string;
}

interface EnrichedOrder extends Order {
  customerName: string;
  customerTier: string;
}

async function getOrdersWithCustomers(): Promise<EnrichedOrder[]> {
  const orders = await query<Order[]>('SELECT id, customer_id, total FROM orders WHERE status = \'pending\'');

  const enriched: EnrichedOrder[] = [];

  // Outer results loop with per-row child queries — classic N+1
  for (const order of orders) {
    const [customer] = await query<Customer[]>(
      `SELECT id, name, tier FROM customers WHERE id = '${order.customerId}'`
    );

    enriched.push({
      ...order,
      customerId: order.customerId,
      customerName: customer?.name ?? 'Unknown',
      customerTier: customer?.tier ?? 'standard',
    });
  }

  return enriched;
}

// Also test while-loop variant
async function getOrdersWhileLoop(): Promise<EnrichedOrder[]> {
  const orders = await query<Order[]>('SELECT id, customer_id, total FROM orders');

  let i = 0;
  const enriched: EnrichedOrder[] = [];

  while (i < orders.length) {
    const order = orders[i];
    const [customer] = await query<Customer[]>(
      `SELECT name, tier FROM customers WHERE id = '${order.customerId}'`
    );

    enriched.push({
      ...order,
      customerId: order.customerId,
      customerName: customer?.name ?? 'Unknown',
      customerTier: customer?.tier ?? 'standard',
    });
    i++;
  }

  return enriched;
}

export { getOrdersWithCustomers, getOrdersWhileLoop };

/**
 * Spec-19 item 26 — dry/structural-similarity useless positive.
 * Two 20-line CRUD handler functions with similar structure.
 * Verdict: USELESS — CRUD handlers share structure intentionally.
 * dry/structural-similarity is default-off. Produces 0 violations.
 *
 * Two functions with the same node-type sequence (if → throw → const → await → if → return)
 * but different identifiers and literals. Structural hash matches.
 */

interface Order { id: string; total: number }
interface Product { id: string; price: number }

declare const db: { execute: (q: string) => Promise<{ rows: Record<string, unknown>[] }> };

export async function createOrder(customerId: string, amount: number): Promise<Order> {
  if (!customerId || customerId.length === 0) {
    throw new Error('customerId is required');
  }
  if (amount <= 0) {
    throw new Error('amount must be positive');
  }
  const query = `INSERT INTO orders (customer_id, amount) VALUES ('${customerId}', ${amount}) RETURNING *`;
  const result = await db.execute(query);
  if (!result || result.rows.length === 0) {
    throw new Error('Failed to create order');
  }
  const row = result.rows[0];
  return { id: String(row.id), total: Number(row.total) };
}

export async function updateProduct(productId: string, price: number): Promise<Product> {
  if (!productId || productId.length === 0) {
    throw new Error('productId is required');
  }
  if (price <= 0) {
    throw new Error('price must be positive');
  }
  const query = `UPDATE products SET price = ${price} WHERE id = '${productId}' RETURNING *`;
  const result = await db.execute(query);
  if (!result || result.rows.length === 0) {
    throw new Error('Failed to update product');
  }
  const row = result.rows[0];
  return { id: String(row.id), price: Number(row.price) };
}

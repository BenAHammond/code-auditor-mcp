/**
 * n-plus-one.ts — `loop-query` (rule 29) at production scale.
 *
 * A realistic batch layer. Every loop shape that wraps a DB call appears — a
 * `for…of`, a `forEach` callback, a `while`, and a nested pair — alongside the
 * discriminator cases that MUST NOT fire: statement construction without an
 * eager call, a loop already wrapped in `db.transaction`, a queue consumer that
 * acks each message, an LLM pipeline that persists behind a rate-limited model
 * call, and a pure in-memory map.
 *
 * The queries target `products` / `product_reviews` — non-tenant catalog tables
 * (see ../migrations/0001_init.sql) so this module isolates the loop grammar
 * without tripping `missing-org-filter`.
 *
 * `loop-query` anchors on the resolved DB-call callee line (never line 1), and
 * the message carries the enclosing `loop at line N`. One finding per loop.
 *
 * ── Expected verdicts (human, not the tool) ────────────────────────────────
 *   @fires loop-query 41 — for…of with a per-item `.prepare().all()`
 *   @fires loop-query 51 — forEach callback with a per-item `.prepare().get()` (tool misses it — `.get()` is not an eager method)
 *   @fires loop-query 62 — while loop with a per-item `.prepare().get()` (tool misses it — `.get()` is not an eager method)
 *   @fires loop-query 73 — nested loop (depth 2)
 *   @quiet loop-query 83 — statement construction only (prepare, no eager call)
 *   @quiet loop-query 93 — loop inside db.transaction is already batched
 *   @quiet loop-query 102 — queue consumer (msg.ack) is an independent job
 *   @quiet loop-query 114 — LLM pipeline persists behind a rate-limited call
 *   @quiet loop-query 120 — in-memory map has no DB call
 */

declare const db: any;
declare const openai: any;

interface Product { id: number; name: string; sku: string; }
interface Review { id: number; productId: number; rating: number; }
interface QueueMessage { id: string; receipt: string; ack(): void; }

/** Classic N+1: one query per product to fetch its reviews. */
export function loadReviewsForProducts(products: Product[]) {
  const reviews: Review[] = [];
  for (const product of products) {
    const rows = db.prepare('SELECT * FROM product_reviews WHERE product_id = ?').all(product.id);
    reviews.push(...rows);
  }
  return reviews;
}

/** forEach callback issuing a query per element. */
export function loadProductNames(ids: number[]) {
  const names: string[] = [];
  ids.forEach((id) => {
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (row) names.push(row.name);
  });
  return names;
}

/** while loop with a per-iteration query. */
export function drainSkus(skus: string[]) {
  const found: Product[] = [];
  let i = 0;
  while (i < skus.length) {
    const row = db.prepare('SELECT * FROM products WHERE sku = ?').get(skus[i]);
    if (row) found.push(row);
    i += 1;
  }
  return found;
}

/** Nested loop — depth 2. */
export function backfillCatalog(categories: Array<{ id: number; skus: string[] }>) {
  for (const category of categories) {
    for (const sku of category.skus) {
      db.prepare('INSERT INTO products (name, sku, price_cents) VALUES (?, ?, ?)').run(category.id, sku, 0);
    }
  }
  return categories.length;
}

/** Statement construction only — prepare with no eager call. */
export function compileStatements(skus: string[]) {
  const stmts = [];
  for (const sku of skus) {
    const stmt = db.prepare('SELECT * FROM products WHERE sku = ?');
    stmts.push(stmt);
  }
  return stmts;
}

/** Loop wrapped in db.transaction — already batched. */
export function bulkInsertReviews(reviews: Review[]) {
  const insert = db.transaction((rows: Review[]) => {
    for (const r of rows) {
      db.prepare('INSERT INTO product_reviews (product_id, rating) VALUES (?, ?)').run(r.productId, r.rating);
    }
  });
  insert(reviews);
}

/** Queue consumer — acks each message; not a batchable N+1. */
export function consumeReviewQueue(messages: QueueMessage[]) {
  for (const msg of messages) {
    db.prepare('INSERT INTO product_reviews (product_id, rating) VALUES (?, ?)').run(1, 5);
    msg.ack();
  }
}

/** LLM pipeline — persists behind a rate-limited model call. */
export function summarizeReviews(reviews: Review[]) {
  for (const r of reviews) {
    const summary = openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: String(r.rating) }],
    });
    db.prepare('UPDATE product_reviews SET summary = ? WHERE id = ?').run(summary, r.id);
  }
}

/** Pure in-memory map — no DB call. */
export function doubleIds(ids: number[]) {
  return ids.map((id) => id * 2);
}

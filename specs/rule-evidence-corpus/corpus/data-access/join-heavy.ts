/**
 * join-heavy.ts — `complex-query` (rule 26) at production scale.
 *
 * A realistic analytics read layer that joins the non-tenant catalog tables
 * declared in ./migrations/0001_init.sql. `complex-query` reads the
 * `data-access-calls` fact and fires `high` when one query references more than
 * `joinedTableCount` tables (default 4). It counts *distinct table names* the
 * `extractTables` scan finds in a single DB call's text (the FROM/JOIN
 * patterns), so a 6-way join is one finding anchored at the call's own line —
 * not one finding per table. It never cross-references the table catalog, so a
 * join over non-tenant tables still fires.
 *
 * Every query here targets a non-tenant table, so the SELECT reads stay quiet
 * for the sibling rules `missing-org-filter` (tenant predicate only) and the
 * `unfiltered-query` read half (tenant table only). The threshold boundary is
 * the point: 5 tables fires, 4 tables is the last quiet count.
 *
 * ── Expected verdicts (human, not the tool) ────────────────────────────────
 *   @fires complex-query 30 — six-table join (products + product_reviews + categories + suppliers + warehouses + inventory)
 *   @fires complex-query 44 — five-table join (one table over the boundary)
 *   @quiet complex-query 57 — four-table join is the last quiet count (not > 4)
 *   @quiet complex-query 68 — two-table join stays quiet
 *   @quiet complex-query 78 — single-table read stays quiet
 */

declare const db: any;

/** A six-table analytics rollup: every catalog table the warehouse touches. */
export function categorySalesRollup() {
  return db.all(`
    SELECT c.name, s.name, w.name, SUM(i.quantity) AS on_hand
    FROM products p
    JOIN product_reviews r ON r.product_id = p.id
    JOIN categories c ON c.id = p.category_id
    JOIN suppliers s ON s.id = p.supplier_id
    JOIN warehouses w ON w.id = p.warehouse_id
    JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = w.id
    GROUP BY c.name, s.name, w.name
  `);
}

/** Five tables — one past the default joinedTableCount of 4. */
export function productReviewRollup() {
  return db.all(`
    SELECT p.name, s.name, c.name, w.name, AVG(r.rating) AS avg_rating
    FROM products p
    JOIN product_reviews r ON r.product_id = p.id
    JOIN categories c ON c.id = p.category_id
    JOIN suppliers s ON s.id = p.supplier_id
    JOIN warehouses w ON w.id = p.warehouse_id
    GROUP BY p.name, s.name, c.name, w.name
  `);
}

/** Exactly four tables — the boundary: not > 4, so quiet. */
export function supplierInventory() {
  return db.all(`
    SELECT s.name, w.name, i.quantity
    FROM suppliers s
    JOIN products p ON p.supplier_id = s.id
    JOIN inventory i ON i.product_id = p.id
    JOIN warehouses w ON w.id = i.warehouse_id
  `);
}

/** Two tables — comfortably under the threshold. */
export function categoryProductCounts() {
  return db.all(`
    SELECT c.name, COUNT(p.id) AS product_count
    FROM categories c
    JOIN products p ON p.category_id = c.id
    GROUP BY c.name
  `);
}

/** A single-table read — the trivial case. */
export function listAllProducts() {
  return db.all('SELECT p.name, p.sku, p.price_cents FROM products p');
}

/**
 * query-heavy-function.ts — `too-many-queries` (rule 58) at production scale.
 *
 * A read layer where one function has grown to issue many queries instead of
 * one join. `too-many-queries` reads the `query-sites` fact (Spec 69 R2) — the
 * located query sites, each attributed to its *innermost* enclosing function —
 * and fires `high` when a function owns more than `maxQueriesPerFunction`
 * (default 5) sites. The finding anchors at the function's own declaration
 * line, not at any individual query.
 *
 * The old `function-bodies` producer counted a function's queries by scanning
 * its full source text, so a nested closure's sites were counted twice (once
 * in the closure, once in every enclosing function). The R2 fix replaces that
 * with located sites + innermost attribution, so `queriesNested` — 4 sites in
 * the outer body, 3 in a closure — stays quiet for both (4 ≤ 5, 3 ≤ 5) where
 * the old counter would have read the outer as 7 and fired.
 *
 * ── Expected verdicts (human, not the tool) ────────────────────────────────
 *   @fires too-many-queries 27 — six query sites in one function (over the 5 ceiling)
 *   @quiet too-many-queries 39 — exactly five sites is the last quiet count (not > 5)
 *   @quiet too-many-queries 50 — four own sites + a 3-site closure: innermost attribution keeps both quiet (the R2 double-count pin)
 */

declare const db: any;

/** Six sites — over the default maxQueriesPerFunction of 5. */
export function ordersAndInventoryReport() {
  const products = db.all('SELECT id, name, price_cents FROM products');
  const lowStock = db.all('SELECT product_id, quantity FROM inventory WHERE quantity < 10');
  const reviews = db.all('SELECT product_id, AVG(rating) AS avg_rating FROM product_reviews GROUP BY product_id');
  const categories = db.all('SELECT id, name FROM categories');
  const suppliers = db.all('SELECT id, name FROM suppliers');
  const warehouses = db.all('SELECT id, name, region FROM warehouses');

  return { products, lowStock, reviews, categories, suppliers, warehouses };
}

/** Exactly five sites — the boundary: not > 5, so quiet. */
export function warehouseSummary() {
  const warehouses = db.all('SELECT id, name, region FROM warehouses');
  const stock = db.all('SELECT warehouse_id, SUM(quantity) AS total FROM inventory GROUP BY warehouse_id');
  const suppliers = db.all('SELECT id, name FROM suppliers');
  const categories = db.all('SELECT id, name FROM categories');
  const products = db.all('SELECT id, name FROM products');

  return { warehouses, stock, suppliers, categories, products };
}

/** Four own sites plus a 3-site closure — the R2 innermost-attribution pin. */
export function productDetailBundled() {
  const product = db.all('SELECT id, name, price_cents FROM products WHERE id = 1');
  const reviews = db.all('SELECT rating, body FROM product_reviews WHERE product_id = 1');
  const stock = db.all('SELECT quantity FROM inventory WHERE product_id = 1');
  const category = db.all('SELECT name FROM categories WHERE id = 1');

  const loadSuppliers = () => {
    const s1 = db.all('SELECT name FROM suppliers WHERE id = 1');
    const s2 = db.all('SELECT name FROM suppliers WHERE id = 2');
    const s3 = db.all('SELECT name FROM suppliers WHERE id = 3');
    return [s1, s2, s3];
  };

  return { product, reviews, stock, category, suppliers: loadSuppliers() };
}

/**
 * sql-injection-surface.ts — `sql-injection-risk` (rule 24) at production scale.
 *
 * A realistic product-catalog query layer. Every way a developer assembles a
 * dynamic SQL string appears: raw template interpolation, inline quote-doubling,
 * quote-doubling hoisted into a variable, a sanitizer the allowlist trusts by
 * name, driver placeholders (`?` / `$1` / `:name`), a `.prepare().bind()` chain,
 * string concatenation with `+`, `.concat()`, and a drizzle tagged template.
 *
 * The queries target `products` — a deliberately non-tenant catalog table (no
 * organization/tenant column, see ../migrations/0001_init.sql) so this module
 * isolates the *injection* grammar without tripping `missing-org-filter`, which
 * would otherwise fire on every tenant-table query lacking an organization
 * predicate.
 *
 * `sql-injection-risk` anchors on the DB-call line (`node.location.start.line`),
 * NOT the SQL string's line. Severity is `critical` for raw interpolation and
 * `high` when every unresolved part is quote-escaped (`.replace(/'/g, "''")`).
 *
 * ── Expected verdicts (human, not the tool) ────────────────────────────────
 *   @fires sql-injection-risk 60:critical — raw template interpolation, unguarded
 *   @fires sql-injection-risk 65:high — inline quote-doubling is defended, not raw
 *   @fires sql-injection-risk 72:high — quote-doubling hoisted to a variable is still escaped (tool over-reports critical)
 *   @quiet sql-injection-risk 77 — sanitizer allowlist (escapeSql) trusted by name
 *   @quiet sql-injection-risk 82 — `?` placeholder is parameterized
 *   @quiet sql-injection-risk 87 — `$1` placeholder is parameterized
 *   @quiet sql-injection-risk 92 — `:name` placeholder is parameterized
 *   @fires sql-injection-risk 97:critical — string concatenation with `+`
 *   @fires sql-injection-risk 102:critical — `.concat()` concatenation
 *   @quiet sql-injection-risk 107 — `.prepare().bind()` chain is parameterized
 *   @quiet sql-injection-risk 113 — drizzle sql`…` tagged template is parameterized by construction — correctly quiet
 */

import { sql } from 'drizzle-orm';

declare const db: any;

/** A production SQL escaper. The sanitizer allowlist (config.sanitizerNames,
 *  default ['escapeSql']) matches this by NAME only — it never reads the body —
 *  so any interpolation wrapped in `escapeSql(...)` reads as sanitized. */
function escapeSql(value: string): string {
  return value.replace(/[\0\x08\x09\x1a\n\r"'\\%]/g, (ch) => {
    switch (ch) {
      case '\0': return '\\0';
      case '\b': return '\\b';
      case '\t': return '\\t';
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '"': return '\\"';
      case "'": return "''";
      case '\\': return '\\\\';
      case '%': return '\\%';
      default: return ch;
    }
  });
}

/** Raw template interpolation — the input is interpolated unguarded. */
export function searchProductsByKeyword(keyword: string) {
  return db.query(`SELECT * FROM products WHERE name LIKE '%${keyword}%'`);
}

/** Inline quote-doubling — defended but not provably safe → high. */
export function searchProductsEscaped(keyword: string) {
  return db.query(`SELECT * FROM products WHERE name LIKE '%${keyword.replace(/'/g, "''")}%'`);
}

/** Quote-doubling hoisted to a variable — still escaped, but the interpolation
 *  no longer carries the `.replace()`, so the escape detector misses it. */
export function searchProductsEscapedVar(keyword: string) {
  const safe = keyword.replace(/'/g, "''");
  return db.query(`SELECT * FROM products WHERE name LIKE '%${safe}%'`);
}

/** A sanitizer the allowlist trusts by name. */
export function searchProductsSanitized(keyword: string) {
  return db.query(`SELECT * FROM products WHERE name LIKE '%${escapeSql(keyword)}%'`);
}

/** Driver placeholder `?` — parameterized. */
export function findProductBySku(sku: string) {
  return db.query('SELECT * FROM products WHERE sku = ?', [sku]);
}

/** Driver placeholder `$1` — parameterized. */
export function findProductBySkuPg(sku: string) {
  return db.query('SELECT * FROM products WHERE sku = $1', [sku]);
}

/** Named placeholder `:sku` — parameterized. */
export function findProductBySkuNamed(sku: string) {
  return db.query('SELECT * FROM products WHERE sku = :sku', { sku });
}

/** String concatenation with `+`. */
export function findProductConcat(sku: string) {
  return db.query('SELECT * FROM products WHERE sku = ' + sku);
}

/** `.concat()` concatenation. */
export function findProductConcatMethod(sku: string) {
  return db.query('SELECT * FROM products WHERE sku = '.concat(sku));
}

/** A `.prepare().bind()` chain — parameterized. */
export function findProductPrepared(sku: string) {
  return db.prepare('SELECT * FROM products WHERE sku = ?').bind(sku).get();
}

/** Drizzle tagged template — parameterized by construction. The detector stays
 *  quiet here, but for an incidental reason: the tag's template is a direct
 *  child of the call (no `arguments` node), so `isDynamicStringConstruction`
 *  never recurses into it. Correct result, unsteady mechanism — a raw
 *  interpolation inside a tag would be missed the same way. */
export function findProductTagged(id: number) {
  return db.execute(sql`SELECT * FROM products WHERE id = ${id}`);
}

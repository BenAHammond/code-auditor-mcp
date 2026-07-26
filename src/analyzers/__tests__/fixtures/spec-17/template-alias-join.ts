/**
 * Spec 22 Item 4 — Sibling fixture: JOIN alias
 *
 * `JOIN ${t} y` — after resolveTemplateExpressions(), `t` is the template
 * variable (replaced with __TMPL__ sentinel), NOT a table name. `y` is the
 * alias. The sentinel preserves token boundaries so the bare-alias regex
 * correctly identifies `y` as the alias and `__TMPL__` is filtered as a
 * template placeholder.
 *
 * All table references in this fixture are template-based. Zero
 * unknown-table findings expected.
 */

import { sql } from "drizzle-orm";

const t = "orders_table";

export function getUserOrders(): string {
  return sql`SELECT y.id, y.total FROM ${t} y WHERE y.active = true`;
}

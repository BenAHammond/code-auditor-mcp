/**
 * Spec 22 Item 4 — Sibling fixture: FROM alias
 *
 * `FROM ${t} x` — after resolveTemplateExpressions(), `t` is the template
 * variable (replaced with __TMPL__ sentinel), NOT a table name. `x` is the
 * alias. The sentinel preserves token boundaries so the bare-alias regex
 * correctly identifies `x` as the alias and `__TMPL__` is filtered as a
 * template placeholder.
 *
 * All table references in this fixture are template-based. Zero
 * unknown-table findings expected.
 */

import { sql } from "drizzle-orm";

const t = "users_table";

export function getUsers(): string {
  return sql`SELECT x.id, x.name FROM ${t} x WHERE x.active = true`;
}

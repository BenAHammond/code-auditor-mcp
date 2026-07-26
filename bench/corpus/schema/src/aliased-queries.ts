/**
 * Spec 22 R4.4: Aliased SQL queries — base table only, no alias leakage.
 *
 * All queries use only known tables (users, orders, products) with aliases.
 * If the alias filter works correctly, only the base tables are extracted
 * → zero unknown-table violations. If aliases leak through, u, o, p would
 * appear as unknown tables → false positives.
 */
async function explicitAliasQuery(): Promise<void> {
  // Explicit AS aliases — u and o should NOT be extracted as tables
  await db.exec(`
    SELECT u.name, o.total
    FROM users AS u
    JOIN orders AS o ON o.user_id = u.id
    WHERE u.active = true
  `);
}

async function bareAliasQuery(): Promise<void> {
  // Bare aliases (no AS keyword) — u and o should NOT be extracted as tables
  await db.exec(`
    SELECT u.name, o.total
    FROM users u
    JOIN orders o ON o.user_id = u.id
  `);
}

async function mixedAliasQuery(): Promise<void> {
  // Mix of explicit and bare aliases
  await db.exec(`
    SELECT u.name, o.total, p.sku
    FROM users AS u
    JOIN orders o ON o.user_id = u.id
    JOIN products AS p ON p.id = o.product_id
  `);
}

// Mock db for compilation
const db = {
  exec: async (_sql: string): Promise<void> => {},
};

export { explicitAliasQuery, bareAliasQuery, mixedAliasQuery };

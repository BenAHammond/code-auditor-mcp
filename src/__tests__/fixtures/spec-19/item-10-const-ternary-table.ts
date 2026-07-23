/**
 * Spec-19 item 10 — sql-injection-risk false positive.
 * Ternary over `as const` string literals in a .query() call.
 * Both branches are known literals — no user-controlled interpolation.
 * The violation should NOT fire: type-narrowed table name, both branches are constants.
 */

import { query } from './db';

const TableName = {
  PROD: 'analytics_prod',
  STAGING: 'analytics_staging',
} as const;

type Env = 'production' | 'staging';

async function getAnalytics(env: Env) {
  // Table name resolved from a closed set of const string literals
  const table = env === 'production' ? TableName.PROD : TableName.STAGING;

  const rows = await query(`SELECT * FROM ${table} WHERE date > $1`, [new Date()]);
  return rows;
}

export { getAnalytics };

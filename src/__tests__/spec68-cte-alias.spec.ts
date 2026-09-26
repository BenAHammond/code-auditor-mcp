/**
 * Spec 68 — the CTE/alias unknown-table false positives (Disposition 1's second
 * class: `callers`, `deps`, `paths`, `coverage`, `best_coverage`,
 * `schema_usage_old`). These are precision defects, not fixture noise: the
 * analyzer's own SQL is written with recursive CTEs and comma-separated CTE
 * lists, and `extractAliasIdentifiers` only recognized the single-CTE
 * `WITH name AS (` shape — no `RECURSIVE` keyword, no column list, no
 * comma-separated siblings — so every CTE name after the first (and every
 * recursive CTE name) leaked into FROM/JOIN references and was flagged
 * unknown-table at critical severity.
 *
 * Red-first: these tests pin the failing shapes against `parseSqlTables` before
 * the fix lands, using the exact SQL the analyzer emits in codeIndexDB.ts.
 */

import { describe, it, expect } from 'vitest';
import { parseSqlTables } from '../analyzers/universal/schema/codeAnalysis.js';

function tables(sql: string, allTables: string[] = []): string[] {
  return parseSqlTables(sql, { line: 1, column: 1 }, sql, new Set(allTables)).map(
    (r) => r.table,
  );
}

describe('Spec 68 — CTE/alias false positives', () => {
  it('does not flag a recursive CTE name with a column list (deps)', () => {
    const out = tables(`
      WITH RECURSIVE deps(id, callee_name, depth) AS (
        SELECT fc.caller_id, fc.callee_name, 1
        FROM function_calls fc
        UNION
        SELECT fc.caller_id, fc.callee_name, deps.depth + 1
        FROM function_calls fc
        JOIN deps ON fc.caller_id IN (SELECT id FROM functions WHERE name = deps.callee_name)
      )
      SELECT DISTINCT callee_name FROM deps
    `, ['function_calls', 'functions']);

    expect(out).not.toContain('deps');
    expect(out).toContain('function_calls');
    expect(out).toContain('functions');
  });

  it('does not flag a recursive CTE name with a column list (callers)', () => {
    const out = tables(`
      WITH RECURSIVE callers(id, caller_name, depth) AS (
        SELECT fc.caller_id, f.name, 1
        FROM function_calls fc
        JOIN functions f ON f.id = fc.caller_id
        UNION
        SELECT fc.caller_id, f2.name, callers.depth + 1
        FROM function_calls fc
        JOIN functions f2 ON f2.id = fc.caller_id
        JOIN functions f3 ON f3.name = callers.caller_name
      )
      SELECT DISTINCT caller_name FROM callers
    `, ['function_calls', 'functions']);

    expect(out).not.toContain('callers');
  });

  it('does not flag a comma-separated CTE sibling (coverage, best_coverage)', () => {
    const out = tables(`
      WITH ranked AS (
        SELECT f.name, f.file_path FROM functions f
      ),
      coverage AS (
        SELECT DISTINCT function_name, file_path FROM coverage_data WHERE covered = 1
      )
      SELECT r.name
      FROM ranked r
      LEFT JOIN coverage c ON c.function_name = r.name
    `, ['functions', 'coverage_data']);

    expect(out).not.toContain('ranked');
    expect(out).not.toContain('coverage');
    expect(out).toContain('functions');
    expect(out).toContain('coverage_data');
  });

  it('does not flag a rename target referenced by the migration that drops it', () => {
    const out = tables(`
      ALTER TABLE schema_usage RENAME TO schema_usage_old;
      INSERT INTO schema_usage (table_name, file_path)
        SELECT table_name, file_path FROM schema_usage_old;
      DROP TABLE schema_usage_old;
    `, ['schema_usage']);

    expect(out).not.toContain('schema_usage_old');
    // The rename's own INSERT INTO the real table is still a write reference.
    expect(out).toContain('schema_usage');
  });
});

/**
 * Spec 49 Session 22 — `cross-domain/transaction-boundary` → `multi-table-write` (row 84).
 *
 * The ledger gap: the rule ID and its registry message claimed "transaction
 * boundary spans N tables", but the code only counts distinct write targets
 * (schema_usage write rows) — there is no BEGIN/COMMIT/savepoint/transaction-API
 * detection. Writing to many tables is a real signal, but the name asserted a
 * transaction boundary the rule never computes.
 *
 * These tests pin the honest name and message. The detection (write-count ≥
 * txnTableMax) is unchanged — this is a rename, not a predicate change — so the
 * positive case fails pre-change (it emits the old ID) while the near-miss
 * passes pre-change (it already did not fire).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CodeIndexDB } from '../../../codeIndexDB.js';
import { CrossDomainAnalyzer } from '../CrossDomainAnalyzer.js';
import { RULE_REGISTRY } from '../../ruleRegistry.js';

async function freshDb(): Promise<CodeIndexDB> {
  CodeIndexDB.resetInstance();
  const db = CodeIndexDB.getInstance(':memory:');
  await db.initialize();
  return db;
}

function seedUsage(db: CodeIndexDB, rows: Array<{ table: string; fn: string; type: string }>): void {
  for (const r of rows) {
    db.run(
      `INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
       VALUES (?, ?, ?, ?, ?)`,
      [r.table, '/test/project/src/app.ts', r.fn, r.type, 1],
    );
  }
}

describe('cross-domain/multi-table-write (write-count, honest name)', () => {
  let db: CodeIndexDB;
  let analyzer: CrossDomainAnalyzer;

  beforeEach(async () => {
    db = await freshDb();
    analyzer = new CrossDomainAnalyzer();
  });

  afterEach(() => {
    CodeIndexDB.resetInstance();
  });

  it('positive — a function writing to ≥ txnTableMax tables fires under the honest rule ID', async () => {
    seedUsage(db, [
      { table: 'a', fn: 'migrate', type: 'update' },
      { table: 'b', fn: 'migrate', type: 'update' },
      { table: 'c', fn: 'migrate', type: 'insert' },
      { table: 'd', fn: 'migrate', type: 'insert' },
    ]);

    const result = await analyzer.analyze(['/test/project/src/app.ts'], {
      indexHandle: db,
      projectRoot: '/test/project',
    });

    const v = result.violations.filter(x => x.rule === 'cross-domain/multi-table-write');
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain('distinct tables');
    expect(v[0].message).not.toContain('spans');
  });

  it('near-miss — fewer than txnTableMax tables does NOT fire', async () => {
    seedUsage(db, [
      { table: 'users', fn: 'updateUser', type: 'update' },
      { table: 'audit_log', fn: 'updateUser', type: 'insert' },
    ]);

    const result = await analyzer.analyze(['/test/project/src/app.ts'], {
      indexHandle: db,
      projectRoot: '/test/project',
    });

    expect(result.violations.filter(x => x.rule === 'cross-domain/multi-table-write')).toHaveLength(0);
  });

  it('registry message claims the write-count, not a transaction boundary', () => {
    const entry = RULE_REGISTRY['cross-domain/multi-table-write'];
    expect(entry).toBeDefined();
    expect(entry.message).toContain('distinct tables');
    expect(entry.message).not.toContain('spans');
    expect(entry.message).not.toMatch(/transaction boundary/i);
  });
});

/**
 * Go data-access method-surface guard — pin `dbMethodName`'s SQL-argument
 * index against the idioms it claims to cover, and pin the *coverage* of that
 * table: every selector name in `dbMethodName` must have a fixture that fires.
 *
 * `dbMethodName` (`src/languages/go/analyzer-src/dataaccess.go`) maps a method
 * selector name to the index of the SQL-string argument. The index is
 * load-bearing and easy to get silently wrong: extract the wrong argument and
 * the analyzer sees a `context.Context` (or a destination pointer), finds no
 * string literal, and returns early with **zero** findings — a hollow
 * capability, not a loud failure. That is exactly the failure mode this test
 * exists to catch, and it has happened twice:
 *
 *   1. The `sqlx` idiom (`Get`/`Select`/`GetContext`/`SelectContext`/`Queryx`/
 *      `NamedExec`/`MustExec`) was missing entirely — real `database/sql`
 *      wrappers produced 0 findings.
 *   2. The `database/sql` **Context variants** (`QueryContext`/`ExecContext`/
 *      `QueryRowContext`/`PrepareContext`) were mapped to arg[0] — the ctx —
 *      instead of arg[1], silently skipping the canonical parameterized form
 *      that dominates production Go since 1.8.
 *
 * An earlier revision pinned only the findings *present that day* (9
 * `missing-org-filter` + 3 `unfiltered-query`). That assertion could stay green
 * while a method silently regressed: delete the fixture for `QueryRow` and the
 * twelve-count still held, because `QueryRow` was never in the fixture to begin
 * with. The coverage assertion below is the fix — it enumerates the full 23-name
 * table and asserts that the union of methods observed in findings equals it, so
 * a missing fixture, a removed case, or a wrong arg index all fail red.
 *
 * Tenancy is DECLARED here (`orgFilterTables: ['users']`), mirroring the TS
 * three-tier model. The old analyzer hardcoded a `tenantTables` word list; the
 * new one reads declared tenancy only, so this test passes it explicitly — a
 * fixture that declared no tenancy would correctly report "no tenant tables"
 * and fire nothing.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

const goDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'languages', 'go');
const goos = process.platform === 'win32' ? 'windows' : process.platform;
const goarch = ({ x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' } as Record<string, string>)[process.arch] ?? 'amd64';
const binaryName = `analyzer-${goos}-${goarch}${goos === 'windows' ? '.exe' : ''}`;
let binaryPath = join(goDir, binaryName);

interface GoViolation {
  analyzer?: string;
  rule?: string;
  severity?: string;
  details?: Record<string, unknown>;
}

/**
 * The full method surface `dbMethodName` claims to cover — the single source of
 * truth the coverage assertion compares against. Kept in the same selector-name
 * order as the Go switch for a readable diff when the two drift.
 */
const DB_METHOD_NAMES = [
  // database/sql — SQL string is arg[0].
  'Query', 'QueryRow', 'Exec', 'Prepare',
  // database/sql Context — ctx first, SQL string is arg[1].
  'QueryContext', 'QueryRowContext', 'ExecContext', 'PrepareContext',
  // sqlx — SQL string is arg[0].
  'Queryx', 'QueryRowx', 'NamedExec', 'NamedQuery', 'MustExec',
  // sqlx Context — ctx first, SQL string is arg[1].
  'QueryxContext', 'QueryRowxContext', 'NamedExecContext', 'NamedQueryContext', 'MustExecContext',
  // sqlx — SQL string is arg[1] (after the destination pointer).
  'Get', 'Select',
  // sqlx — SQL string is arg[2] (after ctx + destination pointer).
  'GetContext', 'SelectContext',
  // GORM — `Raw(sql, values…)`, SQL string is arg[0].
  'Raw',
];

// Every data-access method shape `dbMethodName` claims to cover, each on a
// tenant table (`users`) with no tenant predicate — so each SHOULD fire
// `missing-org-filter` (reads) and/or `unfiltered-query` (writes). The six
// `DELETE FROM users` calls are the writes: each fires BOTH rules (DELETE is
// not INSERT, so it needs a tenant predicate; and a DELETE with no WHERE is an
// unfiltered write). The single `cleanRead` at the bottom is the negative: a
// parameterized, tenant-filtered query that MUST NOT fire.
const SOURCE = `package main

import (
	"context"
	"database/sql"
	"github.com/jmoiron/sqlx"
	"gorm.io/gorm"
)

// database/sql — bare forms take the SQL at arg[0].
func dbBare(db *sql.DB) {
	db.Query("SELECT id FROM users")
	db.QueryRow("SELECT id FROM users")
	db.Exec("DELETE FROM users")
	db.Prepare("SELECT id FROM users")
}

// database/sql — Context forms put ctx first, SQL at arg[1].
func dbContext(ctx context.Context, db *sql.DB) {
	db.QueryContext(ctx, "SELECT id FROM users")
	db.QueryRowContext(ctx, "SELECT id FROM users")
	db.ExecContext(ctx, "DELETE FROM users")
	db.PrepareContext(ctx, "SELECT id FROM users")
}

// sqlx — bare forms take the SQL at arg[0].
func sqlxBare(db *sqlx.DB) {
	db.Queryx("SELECT id FROM users")
	db.QueryRowx("SELECT id FROM users")
	db.NamedExec("DELETE FROM users", map[string]any{})
	db.NamedQuery("SELECT id FROM users", map[string]any{})
	db.MustExec("DELETE FROM users")
}

// sqlx — Context forms put ctx first, SQL at arg[1].
func sqlxContext(ctx context.Context, db *sqlx.DB) {
	db.QueryxContext(ctx, "SELECT id FROM users")
	db.QueryRowxContext(ctx, "SELECT id FROM users")
	db.NamedExecContext(ctx, "DELETE FROM users", map[string]any{})
	db.NamedQueryContext(ctx, "SELECT id FROM users", map[string]any{})
	db.MustExecContext(ctx, "DELETE FROM users")
}

// sqlx — Get/Select put the destination pointer before the SQL (arg[1]).
func sqlxGetSelect(db *sqlx.DB) {
	var u struct{ ID int }
	db.Get(&u, "SELECT id, name FROM users")
	var list []struct{ ID int }
	db.Select(&list, "SELECT id FROM users")
}

// sqlx — Context Get/Select put ctx + destination before the SQL (arg[2]).
func sqlxGetSelectContext(ctx context.Context, db *sqlx.DB) {
	var u struct{ ID int }
	db.GetContext(ctx, &u, "SELECT id, name FROM users")
	var list []struct{ ID int }
	db.SelectContext(ctx, &list, "SELECT id FROM users")
}

// GORM — Raw is the full-SQL literal method, SQL at arg[0].
func gormRaw(db *gorm.DB) {
	var u struct{ ID int }
	db.Raw("SELECT id, name FROM users").Scan(&u)
}

// Negative control — parameterized AND tenant-filtered: must produce nothing.
func cleanRead(db *sqlx.DB, orgID int) {
	var list []struct{ ID int }
	db.Select(&list, "SELECT id FROM users WHERE org_id = ?", orgID)
}
`;

/** Rebuild the analyzer binary from source so the test exercises current code,
 *  mirroring goRegistryIds.spec.ts — never writes into src/languages/go. */
async function ensureBinaryFresh(): Promise<void> {
  try {
    const tmp = mkdtempSync(join(tmpdir(), 'ca-go-method-surface-'));
    const freshPath = join(tmp, binaryName);
    await execFileAsync('go', ['build', '-o', freshPath, 'main.go'], { cwd: goDir });
    binaryPath = freshPath;
  } catch {
    // No Go toolchain — fall through to the committed per-platform binary.
  }
}

function analyzeContent(content: string): Promise<GoViolation[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'], cwd: goDir });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => reject(new Error(`Failed to spawn Go analyzer: ${err}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Go analyzer exited with code ${code}: ${stderr}`));
        return;
      }
      try {
        const lines = stdout.trim().split('\n');
        const response = JSON.parse(lines[lines.length - 1]);
        if (response.error) throw new Error(`Go analyzer error: ${response.error.message}`);
        resolve((response.result.violations ?? []) as GoViolation[]);
      } catch (err) {
        reject(new Error(`Failed to parse Go analyzer response: ${err}`));
      }
    });
    child.stdin.write(
      JSON.stringify({
        method: 'analyzeContent',
        params: {
          file: 'surface.go',
          content,
          options: {
            analyzers: ['data-access'],
            // Declared tenancy — the same shape the TS three-tier model hands the
            // subprocess. `users` is the tenant-scoped AND known table so
            // `missing-org-filter` can fire and `unknown-table` stays quiet.
            orgFilterTables: ['users'],
            knownTables: ['users'],
          },
        },
        id: 1,
      }) + '\n',
    );
    child.stdin.end();
  });
}

const DATA_ACCESS_RULES = new Set(['sql-injection-risk', 'missing-org-filter', 'unfiltered-query', 'unknown-table']);

beforeAll(async () => {
  await ensureBinaryFresh();
}, 60_000);

describe('Go data-access method surface', () => {
  it('covers every dbMethodName selector and fires on each idiom', async () => {
    const violations = await analyzeContent(SOURCE);
    const da = violations.filter((v) => v.analyzer === 'go' && DATA_ACCESS_RULES.has(v.rule ?? ''));

    const count = (rule: string) => da.filter((v) => v.rule === rule).length;

    // Coverage assertion — the heart of this test. The union of method names
    // observed across the tenant/write findings must equal the full 23-name
    // table. A method whose arg index is wrong (or whose fixture was dropped)
    // disappears from this set and fails the test even though the count below
    // might still happen to hold.
    const firedMethods = new Set(
      da
        .filter((v) => v.rule === 'missing-org-filter' || v.rule === 'unfiltered-query')
        .map((v) => v.details?.method)
        .filter((m): m is string => typeof m === 'string'),
    );
    expect([...firedMethods].sort()).toEqual([...DB_METHOD_NAMES].sort());

    // 23 methods on `users` with no tenant predicate — all 23 fire
    // missing-org-filter (the 17 reads) and the 6 DELETE writes each add an
    // unfiltered-query. No dynamic SQL → injection stays quiet; every table is
    // exactly `users` (known) → no near-miss.
    expect(count('missing-org-filter')).toBe(23);
    expect(count('unfiltered-query')).toBe(6);
    expect(count('sql-injection-risk')).toBe(0);
    expect(count('unknown-table')).toBe(0);

    // The negative control — a parameterized, tenant-filtered read — must not
    // contribute a single finding. If it does, the tenant-predicate gate
    // (`org_id`) regressed.
    expect(da.length).toBe(29);
  });
});

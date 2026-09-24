/**
 * Go data-access method-surface guard — pin `dbMethodName`'s SQL-argument
 * index against the idioms it claims to cover.
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
 * Each finding is asserted by count per rule, so a regression to either bug
 * drops the count and fails red rather than shipping a silent skip.
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
}

// Every data-access method shape the widened `dbMethodName` claims to cover,
// each on a tenant table (`users`) with no tenant predicate — so each SHOULD
// fire `missing-org-filter` (reads) and/or `unfiltered-query` (writes). The
// single `cleanRead` at the bottom is the negative: a parameterized,
// tenant-filtered query that MUST NOT fire.
const SOURCE = `package main

import (
	"context"
	"database/sql"
	"github.com/jmoiron/sqlx"
	"gorm.io/gorm"
)

// sqlx — Get/Select put the destination pointer before the SQL (arg[1]).
func sqlxReads(db *sqlx.DB, id int) {
	var u struct{ ID int }
	db.Get(&u, "SELECT id, name FROM users WHERE id = ?", id)
	var list []struct{ ID int }
	db.Select(&list, "SELECT id FROM users")
}

// sqlx — Context Get/Select put ctx + destination before the SQL (arg[2]).
func sqlxContextReads(ctx context.Context, db *sqlx.DB, id int) {
	var u struct{ ID int }
	db.GetContext(ctx, &u, "SELECT id, name FROM users WHERE id = ?", id)
	var list []struct{ ID int }
	db.SelectContext(ctx, &list, "SELECT id FROM users")
}

// sqlx — Queryx/QueryRowx and the Exec family take the SQL first (arg[0]).
func sqlxWrites(db *sqlx.DB, name string) {
	db.MustExec("DELETE FROM users")
	db.NamedExec("INSERT INTO users (name) VALUES (:name)", map[string]any{})
	db.Queryx("SELECT id FROM users")
}

// database/sql — the Context variants put ctx first, SQL at arg[1].
func ctxReads(ctx context.Context, db *sql.DB, id int) {
	db.QueryContext(ctx, "SELECT id, name FROM users WHERE id = $1", id)
	db.ExecContext(ctx, "DELETE FROM users")
}

// GORM — Raw is the full-SQL literal method, SQL at arg[0].
func gormReads(db *gorm.DB, id int) {
	var u struct{ ID int }
	db.Raw("SELECT id, name FROM users WHERE id = ?", id).Scan(&u)
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
        params: { file: 'surface.go', content, options: { analyzers: ['data-access'] } },
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
  it('fires on the sqlx, Context-variant, and GORM Raw idioms', async () => {
    const violations = await analyzeContent(SOURCE);
    const da = violations.filter((v) => v.analyzer === 'go' && DATA_ACCESS_RULES.has(v.rule ?? ''));

    const count = (rule: string) => da.filter((v) => v.rule === rule).length;

    // 9 reads on `users` with no tenant predicate: Get, Select, GetContext,
    // SelectContext, Queryx, QueryContext, ExecContext (DELETE), MustExec
    // (DELETE), Raw.
    expect(count('missing-org-filter')).toBe(9);
    // 3 writes with no WHERE/HAVING/LIMIT: MustExec, NamedExec, ExecContext.
    expect(count('unfiltered-query')).toBe(3);
    // No dynamic SQL in the fixture — the injection rule must stay quiet.
    expect(count('sql-injection-risk')).toBe(0);
    // `users` is a known table; nothing here is a singular/plural near-miss.
    expect(count('unknown-table')).toBe(0);

    // The negative control — a parameterized, tenant-filtered read — must not
    // contribute a single finding. If it does, the tenant-predicate gate
    // (`org_id`) regressed.
    expect(da.length).toBe(12);
  });
});

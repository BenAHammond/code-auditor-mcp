/**
 * Spec 66 R3 — the merge classifies a Go rule by what the Go half *reported it
 * ran*, not by a hardcoded list of "Go's rules".
 *
 * The Go subprocess returns `{ ranRules, violations }`. The merge folds that
 * into coverage generically: a rule id in `violations` → `fired`; in `ranRules`
 * but not `violations` → `clean`; unclaimed → `notApplicable`. Before R3 the
 * merge built Go coverage from violations alone, so a ran-but-clean Go rule
 * (e.g. `error-handling` on a `package main` with no errors) read
 * `notApplicable` — indistinguishable from a rule the Go side never ran. The
 * point of R3 is that "ran clean" and "never ran" are different states, and
 * they must not collapse.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { runAuditDispatch } from '../auditRouter.js';
import type { RuleCoverage } from '../types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ca-spec66-r3-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A clean Go file — fires nothing, so every Go rule that ran reads `clean`. */
const CLEAN_GO = `package main

func main() {}
`;

/** Look up one coverage row by rule id. */
function coverageRow(result: any, ruleId: string): RuleCoverage | undefined {
  return (result.metadata?.coverage ?? []).find((c: RuleCoverage) => c.ruleId === ruleId);
}

describe('Spec 66 R3 — ran-but-clean rules read `clean`, not `notApplicable`', () => {
  it('Go-only repo: a Go rule that ran clean is `clean`; a non-Go rule is `notApplicable`', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'main.go'), CLEAN_GO);
      const result = await runAuditDispatch({ projectRoot: dir, writeToLedger: false } as any);

      // `error-handling` is in the Go side's `ranRules`; no finding fired, so it
      // must read `clean` — the exact state R3 distinguishes from "never ran".
      const errorHandling = coverageRow(result, 'error-handling');
      expect(errorHandling?.state).toBe('clean');

      // `import-organization` likewise ran clean (no imports at all).
      expect(coverageRow(result, 'import-organization')?.state).toBe('clean');

      // `hooks-naming` is a react rule the Go side never ran → `notApplicable`.
      expect(coverageRow(result, 'hooks-naming')?.state).toBe('notApplicable');
    });
  }, 30000);

  it('TS + Go repo: a clean Go rule is `clean`, a fired Go rule is `fired`', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.ts'), 'export const x = 1;\n');
      await writeFile(
        join(dir, 'main.go'),
        `package main

func deadlock() {
	ch := make(chan int)
	ch <- 1
	<-ch
}
`,
      );
      const result = await runAuditDispatch({ projectRoot: dir, writeToLedger: false } as any);

      // Fired Go rule reads `fired`.
      expect(coverageRow(result, 'channel-deadlock')?.state).toBe('fired');

      // Ran-but-clean Go rule reads `clean` — it did not collapse into the TS
      // pipeline's `notApplicable` for an un-run analyzer.
      expect(coverageRow(result, 'error-handling')?.state).toBe('clean');
    });
  }, 30000);
});

/** A Go file with a SELECT against `users` — a tenant-scoped table when the
 *  corpus declares it, but nothing when it does not. */
const USERS_SELECT_GO = `package main

import "database/sql"

func query(db *sql.DB, id int) (*sql.Rows, error) {
	return db.Query("SELECT id, name FROM users WHERE id = $1", id)
}
`;

describe('Spec 66 — undeclared tenancy reads `notApplicable`, never `clean`', () => {
  it('Go-only repo with a DB query and no declared tenancy: missing-org-filter is notApplicable', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'main.go'), USERS_SELECT_GO);
      const result = await runAuditDispatch({ projectRoot: dir, writeToLedger: false } as any);

      // The Go subprocess always reports missing-org-filter in ranRules. With no
      // `.codeauditor.json` and no DDL, its declared input (org-filter tables) is
      // absent — the rule must read `notApplicable` ("nothing to check"), not
      // `clean` ("input present, nothing wrong"). `clean` would be a lie: the
      // corpus is not tenancy-clean, it simply has no declared tenancy.
      const row = coverageRow(result, 'missing-org-filter');
      expect(row?.state).toBe('notApplicable');
      expect(row?.reason).toMatch(/no org-filter tables declared/);

      // Same shape for unknown-table: no known-table catalog is declared.
      const unknown = coverageRow(result, 'unknown-table');
      expect(unknown?.state).toBe('notApplicable');
      expect(unknown?.reason).toMatch(/no known-table catalog declared/);
    });
  }, 30000);

  it('Go-only repo with declared tenancy: missing-org-filter fires on the tenant-table SELECT', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'main.go'), USERS_SELECT_GO);
      await writeFile(
        join(dir, '.codeauditor.json'),
        JSON.stringify({ analyzerConfigs: { 'data-access': { orgFilterTables: ['users'] } } }),
      );
      const result = await runAuditDispatch({ projectRoot: dir, writeToLedger: false } as any);

      // Tenancy declared → the rule's input is present and the unfiltered SELECT
      // on `users` is a real finding. The `fired` state (not `clean`) is the
      // counterpart to the notApplicable case above: declaring tenancy is what
      // turns the silent fail-open into an accusation.
      const row = coverageRow(result, 'missing-org-filter');
      expect(row?.state).toBe('fired');
      expect(row?.count).toBe(1);
    });
  }, 30000);
});

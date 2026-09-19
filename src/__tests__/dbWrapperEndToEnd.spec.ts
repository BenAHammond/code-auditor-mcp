/**
 * Defect #52 — end-to-end: a bare SQL helper wrapper (the `d1(sql)` D1 REST
 * shape) must no longer bypass the table rules. The unit test
 * (`schema/dbWrapper.spec.ts`) proves `buildProvenanceContext` learns the
 * wrapper name and `findTableReferences` extracts its SQL; this test proves the
 * full reducer path: a wrapper-carried reference to a table dropped in a
 * migration surfaces as `stale-table-reference` (not silently skipped).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { initializeLanguages } from '../languages/index.js';
import { initParsers } from '../languages/tree-sitter/parser.js';
import { runAuditDispatch } from '../auditRouter.js';
import type { Violation } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, '..', '..', 'tests', 'fixtures', 'composite');

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

/** Copy the fixture to a temp dir and return its full findings (file paths relativized). */
async function auditFixtureViolations(fixture: string): Promise<Violation[]> {
  const src = join(FIXTURE_ROOT, fixture);
  const tmp = await mkdtemp(join(tmpdir(), 'ca-dbwrapper-'));
  try {
    await cp(src, tmp, { recursive: true });
    const result = await runAuditDispatch({ projectRoot: tmp, writeToLedger: false } as any);
    const all: Violation[] = Object.values(result.analyzerResults as Record<string, any>).flatMap(
      (r: any) => r.violations ?? [],
    );
    return all.map((v: any) => ({ ...v, file: v.file ? relative(tmp, v.file) : v.file }));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Copy the fixture to a temp dir and return its normalized finding set. */
async function auditFixture(fixture: string): Promise<string[]> {
  const all = await auditFixtureViolations(fixture);
  return all
    .map((v: any) => {
      const rule = `${v.analyzer}::${v.rule ?? v.type ?? v.issueType ?? '(none)'}`;
      return `${rule}@${v.file ?? '(no file)'}:${v.line ?? ''}`;
    })
    .sort();
}

describe('schema-wrapper composite fixture (defect #52)', () => {
  it('flags a wrapper-carried reference to a dropped table as stale', async () => {
    const findings = await auditFixture('schema-wrapper');
    expect(findings).toContain('schema::stale-table-reference@src/rewind.ts:19');
  });

  it('does not flag the parameterized-wrapper interpolation as sql-injection-risk', async () => {
    const findings = await auditFixture('schema-wrapper');
    // The interpolated `${placeholders}` call is fully parameterized through the
    // learned `d1(sql, params)` wrapper — the FP guard must clear it.
    expect(findings.some(f => f.startsWith('data-access::sql-injection-risk'))).toBe(false);
    // …while the carried reference to the dropped table still surfaces.
    expect(findings.filter(f => f.startsWith('schema::stale-table-reference')).length).toBeGreaterThanOrEqual(2);
  });

  // Defect #53 — the stale-table resolution must not over-claim a successor
  // table. A dropped table's migration may introduce new tables with
  // incompatible schemas (the file should be removed), so the summary names the
  // introduced tables as context and leaves update-vs-remove to the reviewer.
  it('does not over-claim a successor table in the stale-table resolution', async () => {
    const all = await auditFixtureViolations('schema-wrapper');
    const stale = all.filter((v: any) => v.rule === 'stale-table-reference');
    expect(stale.length).toBeGreaterThanOrEqual(2);
    for (const v of stale) {
      const summary = (v as any).resolution?.summary ?? '';
      expect(summary).toContain('review this reference and update or remove it');
      expect(summary).not.toContain('to a table that still exists');
    }
  });
});

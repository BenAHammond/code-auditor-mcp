/**
 * Spec 66 R5 — entry-point coverage conformance.
 *
 * The guard for the language-dispatch rewrite. Every audit entry point must
 * return an `AuditResult` whose `metadata.coverage` accounts for EVERY rule in
 * `RULE_REGISTRY` — one row per rule, in a defined state (`fired` | `clean` |
 * `notApplicable` | `cannot-fire`). A rule that exists in the registry but is
 * absent from coverage is the defect this whole spec exists to correct: the
 * polyglot path (`convertPolyglotToAuditResult`) hand-builds a partial result
 * that drops `coverage` entirely, so a mixed-language repo audits with a
 * reduced analyzer set and no coverage entry says so.
 *
 * Written red-first: before R1–R4, the TS + Go case fails — `runAuditDispatch`
 * routes the whole repo through the orchestrator on any `.go` file, and the
 * returned result carries no coverage, so all 100 rules are "missing". The
 * TS-only case is the control: the full four-stage pipeline already produces
 * coverage, and it must keep doing so once the mixed path is fixed.
 *
 * A guard written after the fix has only ever passed. This one exists to fail
 * first.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { runAuditDispatch } from '../auditRouter.js';
import { RULE_REGISTRY, MCP_DEFAULT_ANALYZERS } from '../analyzers/ruleRegistry.js';

/** Every rule id the registry declares — the set coverage must account for. */
const ALL_RULE_IDS = Object.keys(RULE_REGISTRY);

/** Rule ids present in the registry but absent from the returned coverage. */
function missingRuleIds(result: { metadata?: { coverage?: Array<{ ruleId: string }> } }): string[] {
  const covered = new Set((result.metadata?.coverage ?? []).map((c) => c.ruleId));
  return ALL_RULE_IDS.filter((id) => !covered.has(id));
}

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

/** Run the fixture in a temp dir and clean it up regardless of outcome. */
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ca-spec66-r5-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('Spec 66 R5 — every entry point accounts for all 100 registry rules', () => {
  it('CLI full on a TypeScript-only repo: coverage covers all rules', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.ts'), 'export const x = 1;\n');
      const result = await runAuditDispatch({ projectRoot: dir, writeToLedger: false } as any);
      expect(missingRuleIds(result)).toEqual([]);
    });
  });

  it('CLI full on a repo with a Go file present: coverage covers all rules', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.ts'), 'export const x = 1;\n');
      await writeFile(join(dir, 'main.go'), 'package main\n\nfunc main() {}\n');
      const result = await runAuditDispatch({ projectRoot: dir, writeToLedger: false } as any);
      expect(missingRuleIds(result)).toEqual([]);
    });
  }, 30000);

  // R6 — the MCP surface runs the reduced MCP_DEFAULT_ANALYZERS set (6 analyzers),
  // but the coverage contract is unchanged: the difference from the full set must
  // surface as `notApplicable` rows, not as absent rules. A reduced analyzer set
  // must not reintroduce the silence this spec exists to kill.
  it('MCP reduced analyzer set (MCP_DEFAULT_ANALYZERS): coverage still covers all rules', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.ts'), 'export const x = 1;\n');
      const result = await runAuditDispatch({
        projectRoot: dir,
        enabledAnalyzers: [...MCP_DEFAULT_ANALYZERS],
        writeToLedger: false,
      } as any);
      expect(missingRuleIds(result)).toEqual([]);
    });
  });
});

/**
 * Spec 66 R5 — entry-point coverage conformance.
 *
 * The guard for the language-dispatch rewrite. Every audit entry point must
 * return an `AuditResult` whose `metadata.coverage` accounts for EVERY rule in
 * `RULE_REGISTRY` — one row per rule, in a defined state (`fired` | `clean` |
 * `notApplicable` | `cannot-fire`). A rule that exists in the registry but is
 * absent from coverage is the defect this whole spec exists to correct: the
 * pre-dispatch polyglot path (removed in the dispatch rewrite) hand-built a
 * partial result that dropped `coverage` entirely, so a mixed-language repo
 * audited with a reduced analyzer set and no coverage entry said so.
 *
 * Written red-first: before R1–R4, the TS + Go case fails — the audit path
 * routed the whole repo through the orchestrator the moment a `.go` file was
 * present, and the returned result carried no coverage, so all 100 rules were
 * "missing". The fixed dispatch (`runAuditDispatch`) branches on
 * `goFiles.length === 0` (auditRouter.ts:98): Go absent → the full TS pipeline,
 * Go present → per-language dispatch. The TS-only case is the control: the full
 * four-stage pipeline already produces coverage, and it must keep doing so once
 * the mixed path is fixed.
 *
 * A guard written after the fix has only ever passed. This one exists to fail
 * first.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// ── Structural entry-point enumeration (Correction #3) ──────────────────────
//
// R5's second half is structural, not a hand-typed list: it enumerates every
// file under `src/` that imports `createAuditRunner` and asserts the set is
// exactly the six known callers. A direct `createAuditRunner` call is the only
// thing that can bypass `runAuditDispatch` and, on a repo with a `.go` file,
// silently drop the Go half — so the set of direct callers must stay closed. A
// *seventh* file that starts importing `createAuditRunner` is a new entry point
// nobody has read, and it fails here (the enumeration no longer matches the
// pinned set) instead of waiting to be discovered as a silent Go drop.
//
// `src/index.ts` is enumerated but excluded: it imports `createAuditRunner` only
// to re-export the library's programmatic surface (`runAudit`,
// `createProjectAuditRunner`), not to audit a repo in the tool's own loop. Its
// exclusion is asserted, not assumed — if the import disappeared the test fails.

const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SRC_ROOT = join(APP_ROOT, 'src');

/** Recursively list `.ts` source files under `src/`, skipping tests. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Repo-relative paths of every file that imports `createAuditRunner`. */
function importersOf(symbol: string): string[] {
  const re = new RegExp(`import\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from`);
  const found: string[] = [];
  for (const file of sourceFiles(SRC_ROOT)) {
    if (re.test(readFileSync(file, 'utf8'))) found.push(relative(APP_ROOT, file));
  }
  return found.sort();
}

/** The closed set of direct `createAuditRunner` callers (entry points), each with its reason. */
const DIRECT_CREATE_AUDIT_RUNNER_CALLERS = [
  // The dispatch itself — the one place that runs the TS half; its Go half is
  // spawned separately, so this call is the mechanism, not a bypass.
  'src/auditRouter.ts',
  // CLI surfaces. `audit` routes through runAuditDispatch; the scoped/diff
  // commands (changed, baseline, outstanding, fingerprint) run a TS/JS-only
  // pass over changed files, which is a deliberate TS scope, not a Go drop.
  'src/cli.ts',
  // The changed-files hook — same TS/JS scoped pass as `changed`.
  'src/hooks/core.ts',
  // Shared MCP handlers: audit.run routes through dispatch; audit.health and
  // friends run the reduced MCP_DEFAULT_ANALYZERS TS pass.
  'src/mcp-tools-shared.ts',
  // Auto-index — runs zero analyzers (enabledAnalyzers: []); indexes only.
  'src/mcpAutoIndex.ts',
  // Next-file incremental — a TS/JS scoped pass over changed files.
  'src/nextFileIncremental.ts',
];

describe('Spec 66 R5 — structural entry-point enumeration', () => {
  it('every direct createAuditRunner importer is one of the six known callers (index.ts excluded with reason)', () => {
    const importers = importersOf('createAuditRunner');
    // index.ts is enumerated but is the library re-export, not an entry point.
    const entryPoints = importers.filter((f) => f !== 'src/index.ts');

    expect(entryPoints).toEqual(DIRECT_CREATE_AUDIT_RUNNER_CALLERS);
    // The exclusion is real — index.ts still imports it (re-export), else this
    // test would silently green while a caller went missing.
    expect(importers).toContain('src/index.ts');
  });
});

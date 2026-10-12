#!/usr/bin/env node
/**
 * verify-recall-cases.ts — the I/O half of the `verify:recall-cases` gate.
 *
 * The pinned-site tests from `e8c14b6` (`spec70-candidate-rejection-pins.spec.ts`)
 * are the mechanism: eight frozen source sites — three secret-candidate sites the
 * `hardcoded-secret` rule must reject, and five loop-query-candidate sites the
 * `loop-query` fold must reduce to not-handle — each read byte-identical from the
 * pinned fixtures under `src/__tests__/fixtures/spec70-candidate-rejection/`. For
 * each site this half asserts two things through the real producers: a fact is
 * *emitted* at the site (recall — a rejection is a classification over a present
 * fact, never a discovery miss), and the verdict *matches* the recorded
 * disposition (no finding). The results feed `checkRecallCases` (the pure
 * predicate in the `.core.mjs` half). No harvested count or pair list is stored.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeLanguages, initParsers, LanguageRegistry } from '../src/languages/index.js';
import { parseFile } from '../src/languages/adapterBridge.js';
import { runSecretsSlice, buildSecretCandidates, runLoopQueriesSlice } from '../src/phase/runner.js';
import { extractLoopQueryRawCandidates } from '../src/analyzers/universal/UniversalDataAccessAnalyzer.js';
import { checkRecallCases } from './verify-recall-cases-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, '..', 'src', '__tests__', 'fixtures', 'spec70-candidate-rejection');

/** The named SQL dialect threading `parseSql` for the loop-query fold. */
const SQL_DIALECT = 'postgresql' as const;

/** Read a pinned corpus fixture (byte-identical to `git show <pin>:<path>`). */
function fixture(name: string): string {
  return readFileSync(join(FIXTURE_ROOT, name), 'utf8');
}

/** The three secret sites (mirrors `spec70-candidate-rejection-pins.spec.ts`). */
const SECRET_SITES = [
  {
    corpus: 'blitz',
    path: 'apps/next13/src/app/auth/layout.tsx',
    fixture: 'blitz-auth-layout.txt',
    line: 5,
    site: 'redirectAuthenticatedTo: "/"',
  },
  {
    corpus: 'openstatus',
    path: 'apps/dashboard/env.ts',
    fixture: 'openstatus-env.txt',
    line: 1,
    site: 'Deno.copyFile("./.env.example", "./.env")',
  },
  {
    corpus: 'recall-protocol',
    path: 'astro.config.mjs',
    fixture: 'recall-protocol-astro-config.txt',
    line: 17,
    site: "name: 'fix-production-jsx-dev-for-build'",
  },
] as const;

/** The loop sites (mirrors `spec70-candidate-rejection-pins.spec.ts`). */
const LOOP_SITES = [
  {
    corpus: 'hhra-org',
    path: 'app/api/admin/etl/folders/route.ts',
    fixture: 'hhra-org-etl-folders-route.txt',
    line: 96,
    method: 'indexOf',
  },
  {
    corpus: 'hhra-org',
    path: 'app/api/admin/etl/folders/route.ts',
    fixture: 'hhra-org-etl-folders-route.txt',
    line: 142,
    method: 'indexOf',
  },
  {
    corpus: 'openstatus',
    path: 'apps/dashboard/src/app/(dashboard)/chat/sidebar.tsx',
    fixture: 'openstatus-chat-sidebar.txt',
    line: 75,
    method: 'mutateAsync',
  },
  {
    corpus: 'recall-protocol',
    path: 'infra/infra.ts',
    fixture: 'recall-protocol-infra.txt',
    line: 98,
    method: 'indexOf',
  },
  {
    corpus: 'recall-protocol',
    path: 'infra/infra.ts',
    fixture: 'recall-protocol-infra.txt',
    line: 210,
    method: 'indexOf',
  },
] as const;

async function main(): Promise<void> {
  initializeLanguages();
  await initParsers();

  const sites: Array<{ id: string; emitted: boolean; verdictMatches: boolean }> = [];

  for (const s of SECRET_SITES) {
    const content = fixture(s.fixture);
    const findings = await runSecretsSlice([{ path: s.path, content }]);
    const atSite = findings.filter((f) => f.ruleId === 'hardcoded-secret' && f.line === s.line);
    const candidates = await buildSecretCandidates([{ path: s.path, content }]);
    const emitted = candidates.some((c) => c.line === s.line);
    // Recorded disposition: the site is *rejected* — no hardcoded-secret finding.
    sites.push({ id: `${s.corpus} ${s.path}:${s.line}`, emitted, verdictMatches: atSite.length === 0 });
  }

  for (const s of LOOP_SITES) {
    const content = fixture(s.fixture);
    const findings = await runLoopQueriesSlice([{ path: s.path, content }], undefined, SQL_DIALECT);
    const atSite = findings.filter((f) => f.ruleId === 'loop-query' && f.line === s.line);

    const adapter = LanguageRegistry.getInstance().getAdapterForFile(s.path);
    if (!adapter) throw new Error(`no adapter for ${s.path}`);
    const ast = parseFile(s.path, content);
    if (!ast) throw new Error(`fixture ${s.path} failed to parse`);
    let emitted = false;
    try {
      const raw = extractLoopQueryRawCandidates(ast, adapter, content);
      emitted = raw.some((c) => c.line === s.line && c.handleMethod === s.method);
    } finally {
      ast.dispose?.();
    }
    // Recorded disposition: the fold reduces the site to not-handle — no finding.
    sites.push({ id: `${s.corpus} ${s.path}:${s.line}`, emitted, verdictMatches: atSite.length === 0 });
  }

  const drift = checkRecallCases({ sites });
  for (const line of drift) console.error(`recall-cases violated: ${line}`);
  if (drift.length > 0) process.exit(1);
  console.log(`recall-cases holds: ${sites.length} pinned site(s) emit a fact and match disposition.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

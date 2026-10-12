/**
 * Spec 70 — candidate-rejection pins (review directive item 4).
 *
 * A hardcoded-secret / loop-query finding is a *classification* over a producer
 * fact. The producer projects every credential-position string and every in-loop
 * DB-shaped call as a *candidate*; the rule (or the corpus producer's
 * `identifyHandle` fold) then rejects the ones that are not real secrets / not
 * real handles. Six sites in the pinned corpora were once read as "false
 * positives" — but they are not findings at all: they are candidate facts the
 * verdict stage correctly folds away.
 *
 *   - The three secret sites: `isSecretName`/`isCredentialSelector`/`looksLikeRealSecret`
 *     reject the name or value, so no `hardcoded-secret` finding is emitted.
 *   - The three loop sites: `parseSql("=")` fails (the `.indexOf('=')`/`.indexOf("=")`
 *     string argument is not SQL) and `identifyHandle` folds the `.mutateAsync`
 *     receiver to not-handle, so no `loop-query` finding is emitted.
 *
 * Nothing previously asserted that the detectors reject these sites. Each test
 * below is drawn from the pinned corpus source at its real path (byte-identical
 * to `git show <pin-sha>:<path>`) and asserts the rejection is *still* the
 * behaviour: green from the start by design, it fails the moment a future change
 * admits the site as a finding. Every test also asserts the candidate fact is
 * produced at the site — so a pass is a proven rejection, not a discovery miss.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeLanguages, LanguageRegistry } from '../languages/index.js';
import { initParsers } from '../languages/tree-sitter/parser.js';
import { parseFile } from '../languages/adapterBridge.js';
import {
  runSecretsSlice,
  buildSecretCandidates,
  runLoopQueriesSlice,
} from '../phase/runner.js';
import { extractLoopQueryRawCandidates } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, 'fixtures', 'spec70-candidate-rejection');

/** A named SQL dialect threads `parseSql` for the loop-query fold. */
const SQL_DIALECT = 'postgresql' as const;

/** Read a pinned corpus fixture (byte-identical to `git show <pin>:<path>`). */
function fixture(name: string): string {
  return readFileSync(join(FIXTURE_ROOT, name), 'utf8');
}

/**
 * The three secret sites. Each is a `secret-candidates` fact (position + name/
 * value) whose name or value the rule rejects; none may produce a finding.
 */
const SECRET_SITES = [
  {
    corpus: 'blitz',
    pin: 'b18f81873e641934043f791fec06e22f5fe5a86e',
    path: 'apps/next13/src/app/auth/layout.tsx',
    fixture: 'blitz-auth-layout.txt',
    line: 5,
    site: 'redirectAuthenticatedTo: "/"',
  },
  {
    corpus: 'openstatus',
    pin: '444a06b851fc3d88bbfd5291c4d036045e6841ca',
    path: 'apps/dashboard/env.ts',
    fixture: 'openstatus-env.txt',
    line: 1,
    site: 'Deno.copyFile("./.env.example", "./.env")',
  },
  {
    corpus: 'recall-protocol',
    pin: 'c007f6ed29c06fede6bdb6edd4d6bf8c35eb346e',
    path: 'astro.config.mjs',
    fixture: 'recall-protocol-astro-config.txt',
    line: 17,
    site: "name: 'fix-production-jsx-dev-for-build'",
  },
] as const;

/**
 * The loop sites. Three corpora, three rejection mechanisms: `line.indexOf('=')`
 * / `line.indexOf("=")` (a string argument that is not SQL, so `parseSql("=")`
 * fails) and `deleteMutation.mutateAsync(...)` (a mutation receiver, not a query
 * handle). The two `hhra-org` lines are the two `line.indexOf('=')` loops in the
 * one file; the two `recall-protocol` lines are the same `indexOf("=")` pattern
 * in two functions.
 */
const LOOP_SITES = [
  {
    corpus: 'hhra-org',
    pin: '56bb7c877dd84bb224c9f57714a64b183ca17c9b',
    path: 'app/api/admin/etl/folders/route.ts',
    fixture: 'hhra-org-etl-folders-route.txt',
    line: 96,
    method: 'indexOf',
    site: "const eq = line.indexOf('=');",
  },
  {
    corpus: 'hhra-org',
    pin: '56bb7c877dd84bb224c9f57714a64b183ca17c9b',
    path: 'app/api/admin/etl/folders/route.ts',
    fixture: 'hhra-org-etl-folders-route.txt',
    line: 142,
    method: 'indexOf',
    site: "const eq = line.indexOf('=');",
  },
  {
    corpus: 'openstatus',
    pin: '444a06b851fc3d88bbfd5291c4d036045e6841ca',
    path: 'apps/dashboard/src/app/(dashboard)/chat/sidebar.tsx',
    fixture: 'openstatus-chat-sidebar.txt',
    line: 75,
    method: 'mutateAsync',
    site: 'await deleteMutation.mutateAsync({ sessionId: s.id });',
  },
  {
    corpus: 'recall-protocol',
    pin: 'c007f6ed29c06fede6bdb6edd4d6bf8c35eb346e',
    path: 'infra/infra.ts',
    fixture: 'recall-protocol-infra.txt',
    line: 98,
    method: 'indexOf',
    site: 'const idx = line.indexOf("=");',
  },
  {
    corpus: 'recall-protocol',
    pin: 'c007f6ed29c06fede6bdb6edd4d6bf8c35eb346e',
    path: 'infra/infra.ts',
    fixture: 'recall-protocol-infra.txt',
    line: 210,
    method: 'indexOf',
    site: 'const eq = item.indexOf("=");',
  },
] as const;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

describe('hardcoded-secret — the three secret sites stay rejected', () => {
  for (const s of SECRET_SITES) {
    it(`emits no finding at ${s.corpus} ${s.path}:${s.line} (${s.site})`, async () => {
      const content = fixture(s.fixture);

      const findings = await runSecretsSlice([{ path: s.path, content }]);
      const atSite = findings.filter(
        (f) => f.ruleId === 'hardcoded-secret' && f.line === s.line,
      );
      expect(atSite, `hardcoded-secret fired at the rejected site ${s.path}:${s.line}`).toEqual([]);

      // Liveness: the candidate fact is still projected at the site — the
      // absence of a finding is a classification decision, not a discovery miss.
      const candidates = await buildSecretCandidates([{ path: s.path, content }]);
      expect(
        candidates.some((c) => c.line === s.line),
        `no secret-candidates fact at ${s.path}:${s.line}`,
      ).toBe(true);
    });
  }
});

describe('loop-query — the loop sites stay folded to not-handle', () => {
  for (const s of LOOP_SITES) {
    it(`emits no finding at ${s.corpus} ${s.path}:${s.line} (${s.site})`, async () => {
      const content = fixture(s.fixture);

      const findings = await runLoopQueriesSlice([{ path: s.path, content }], undefined, SQL_DIALECT);
      const atSite = findings.filter(
        (f) => f.ruleId === 'loop-query' && f.line === s.line,
      );
      expect(atSite, `loop-query fired at the rejected site ${s.path}:${s.line}`).toEqual([]);

      // Liveness: the raw candidate is produced at the site with the expected
      // handle method — the corpus producer's identifyHandle fold drops it, so the
      // absence of a finding is a rejection, not a discovery miss.
      const adapter = LanguageRegistry.getInstance().getAdapterForFile(s.path);
      if (!adapter) throw new Error(`no adapter for ${s.path}`);
      const ast = parseFile(s.path, content);
      expect(ast, `fixture ${s.path} failed to parse`).not.toBeNull();
      const raw = extractLoopQueryRawCandidates(ast!, adapter, content);
      ast!.dispose?.();
      const atLine = raw.filter((c) => c.line === s.line && c.handleMethod === s.method);
      expect(
        atLine.length,
        `no loop-query-candidates fact at ${s.path}:${s.line}`,
      ).toBeGreaterThan(0);
    });
  }
});

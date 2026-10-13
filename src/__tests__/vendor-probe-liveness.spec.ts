/**
 * Item B (reissued) — vendor-probe *liveness* (a finding that appears only because
 * the probe supplied a method the old hand-kept list lacked).
 *
 * The derivation test (`vendor-probe-dataaccess.spec.ts`) pins that the probe
 * *adds* the vendor-only methods when a surface resolves. This test proves the
 * thing the derivation test cannot: that a real finding — `complex-query` on a
 * five-table Kysely chain whose fifth table is reachable only through `fullJoin`
 * — appears when the probe resolves a real Kysely declaration from the fixture's
 * own `node_modules`, and disappears when the probe is absent. That is the
 * liveness the directive requires: "a finding that only appears because the probe
 * supplied a method the old hand-kept list lacked."
 *
 * The fixture `bench/corpus/vendor-probe/` pins `kysely@0.29.6` (committed
 * `package.json` + `package-lock.json`; `node_modules` gitignored). Its
 * `src/kysely-full-join.ts` reaches five tables: four through the analyzer's
 * irreducible baseline grammar (`selectFrom`, `innerJoin`, `leftJoin`), the fifth
 * (`vet`) only through `fullJoin` — a member only the Kysely `SelectQueryBuilder`
 * declaration publishes. With the probe the chain yields five tables and
 * `complex-query` fires (5 > `joinedTableCount` = 4); without it the chain yields
 * four tables — exactly the threshold — and nothing fires.
 *
 * The real vendor is installed on first run (`npm ci` in the fixture dir) so the
 * check never silently skips; a network-free CI must pre-install the fixture
 * dependency. Nothing here is fetched by the *analyzer* at analysis time — the
 * probe reads the tree's installed declaration, never the registry.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeLanguages, initParsers } from '../languages/index.js';
import {
  resolveVendorSurfaces,
  EMPTY_VENDOR_SURFACES,
  type VendorSurfaces,
} from '../analyzers/vendorSurfaces.js';
import { runDataAccessSlice } from '../phase/runner.js';

const FIXTURE = fileURLToPath(new URL('../../bench/corpus/vendor-probe', import.meta.url));
const FIXTURE_SRC = path.join(FIXTURE, 'src', 'kysely-full-join.ts');

beforeAll(async () => {
  // Ensure the real vendor is installed so the liveness check is never vacuous.
  if (!existsSync(path.join(FIXTURE, 'node_modules', 'kysely', 'package.json'))) {
    execSync('npm ci --no-audit --no-fund', { cwd: FIXTURE, stdio: 'pipe' });
  }
  initializeLanguages();
  await initParsers();
}, 120_000);

async function complexQueryFindings(vendorSurfaces: VendorSurfaces): Promise<string[]> {
  const content = readFileSync(FIXTURE_SRC, 'utf8');
  const findings = await runDataAccessSlice(
    [{ path: 'src/kysely-full-join.ts', content }],
    undefined,
    'postgresql',
    vendorSurfaces,
  );
  return findings.filter((f) => f.ruleId === 'complex-query').map((f) => f.message);
}

describe('vendor-probe liveness (item B, reissued)', () => {
  it('resolves the real Kysely declaration from the fixture node_modules, with path + version', () => {
    const s = resolveVendorSurfaces(FIXTURE);
    expect(s.kyselySelectQueryBuilder).not.toBeNull();
    expect(s.kyselyQueryCreator).not.toBeNull();

    const qb = s.resolutions.find((r) => r.pkg === 'kysely' && r.type === 'SelectQueryBuilder')!;
    expect(qb.path).toContain('select-query-builder.d.ts');
    expect(qb.version).toBe('0.29.6');
    expect(qb.reason).toBeNull();

    // The probe-only join verb is a real member of the resolved declaration.
    expect(s.kyselySelectQueryBuilder!.has('fullJoin')).toBe(true);
    // And the baseline join verbs that are NOT Kysely verbs (`join`) are absent
    // from the declaration surface — the analyzer's baseline supplies them.
    expect(s.kyselySelectQueryBuilder!.has('join')).toBe(false);
  });

  it('a probe-only finding appears with the probe and is absent without it', async () => {
    const resolved = resolveVendorSurfaces(FIXTURE);

    const withProbe = await complexQueryFindings(resolved);
    const withoutProbe = await complexQueryFindings(EMPTY_VENDOR_SURFACES);

    expect(withProbe).toEqual(['Query references 5 tables']);
    expect(withoutProbe).toEqual([]);
  });

  it('a tree where the vendor is not installed is unproven with a named reason', () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'vendor-probe-liveness-bare-'));
    try {
      const s = resolveVendorSurfaces(bare);
      const kysely = s.resolutions.filter((r) => r.pkg === 'kysely');
      expect(kysely.length).toBe(2);
      for (const r of kysely) {
        expect(r.path).toBeNull();
        expect(r.version).toBeNull();
        expect(r.reason).toContain('not installed');
      }
      // An unproven Kysely surface means no join probe — the finding cannot fire.
      expect(s.kyselySelectQueryBuilder).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

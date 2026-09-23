/**
 * Spec 62 R9 — gate-liveness tests.
 *
 * A `verify:*` gate exists to fail its own job: it must actually exercise its
 * check and exit non-zero when the condition it guards is violated, never exit 0
 * unconditionally. A gate that "passes" because it checks nothing is the same
 * defect shape as `missing-org-filter` — a clean result from a check that isn't
 * there. This suite is the machine form of that concern: for each gate, it
 * proves the *failure branch is live* (reachable and non-zero) against the
 * gate's own trigger.
 *
 * Four gates are tested here:
 *
 *   - `verify:self`  — the blocking-severity predicate, the scope filter, and
 *     the correct-by-design exemption map, extracted to
 *     `scripts/verify-self-core.mjs` so a predicate regression (re-narrowing to
 *     `critical | severe`, or silently dropping an exemption) fails here instead
 *     of passing the ratchet for months. This is the same extraction that let
 *     `verify-self.mjs` keep its I/O while the decisions become unit-testable.
 *   - `verify:disk-space` — the `freeBytes < MIN_FREE_BYTES` branch, triggered
 *     via its own env knob (`VERIFY_MIN_FREE_BYTES`), no build required.
 *   - `verify:gate-budget` — the `warm >= BUDGET_MS` branch, triggered via the
 *     `VERIFY_GATE_BUDGET_MS` knob added for this test.
 *   - `assert_compatible` — the plugin↔CLI version pin in `hook-common.sh`,
 *     exercised against a fake bin reporting a wrong / missing / matching
 *     version.
 *
 * The remaining gates named in R9 — `verify:dist`, `verify:clean-install`,
 * `verify:languages`, `bench` — are packaging/install/integration operations
 * whose liveness is inherent to the operation (a broken package fails the pack;
 * a language drop fails the wiring assertions). They are covered by running in
 * `verify:close`, not by a unit trigger here.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  inScope,
  isBlockingSeverity,
  isScopedExempt,
  scopedExemptionKey,
  scopedPath,
  staleExemptions,
} from '../../scripts/verify-self-core.mjs';

const APP_ROOT = process.cwd();
const DIST_CLI = join(APP_ROOT, 'dist', 'cli.js');
const HOOK_COMMON = join(APP_ROOT, 'plugin', 'scripts', 'hook-common.sh');

describe('verify:self — blocking-severity predicate', () => {
  it('blocks every severity on the ladder (critical, severe, high) and nothing below', () => {
    // Spec 54 R3 — the gate is all-three. A regression that drops `high` (the
    // two-tier narrowing this test guards) fails here, not in a shipped gate.
    expect(isBlockingSeverity({ severity: 'critical' })).toBe(true);
    expect(isBlockingSeverity({ severity: 'severe' })).toBe(true);
    expect(isBlockingSeverity({ severity: 'high' })).toBe(true);
    // Below the ladder: `off` is a config state; the removed `warning`/`suggestion`
    // tiers are never emitted findings.
    expect(isBlockingSeverity({ severity: 'off' })).toBe(false);
    expect(isBlockingSeverity({ severity: 'warning' })).toBe(false);
    expect(isBlockingSeverity({ severity: 'suggestion' })).toBe(false);
  });
});

describe('verify:self — scope filter and exemptions', () => {
  it('includes production source and excludes data tables / tests / out-of-scope paths', () => {
    expect(inScope('/app/src/analyzers/universal/UniversalSOLIDAnalyzer.ts')).toBe(true);
    expect(inScope('/app/src/languages/RuntimeManager.ts')).toBe(true);
    // The two declarative data-table exclusions.
    expect(inScope('/app/src/analyzers/ruleRegistry.ts')).toBe(false);
    expect(inScope('/app/src/languages/go/analyzer-src/types.go')).toBe(false);
    // Tests / fixtures / out-of-tree paths.
    expect(inScope('/app/src/analyzers/foo.spec.ts')).toBe(false);
    expect(inScope('/app/src/foo.ts')).toBe(false);
    expect(inScope('/no/src/segment.ts')).toBe(false);
  });

  it('exempts exactly the three correct-by-design (file, rule) pairs — nothing else', () => {
    expect(isScopedExempt('languages/RuntimeManager.ts', 'solid/open-closed')).toBe(true);
    expect(isScopedExempt('languages/go/analyzer-src/parser.go', 'switch-size')).toBe(true);
    expect(isScopedExempt('languages/go/parser/go-ast-parser.go', 'switch-size')).toBe(true);
    // A different rule in the same file is NOT exempt — the map is exact.
    expect(isScopedExempt('languages/RuntimeManager.ts', 'solid/method-complexity')).toBe(false);
    expect(isScopedExempt('analyzers/universal/UniversalSecurityAnalyzer.ts', 'dry/duplicate')).toBe(false);
    // An unknown file/rule pair is not exempt.
    expect(isScopedExempt('analyzers/nowhere/Else.ts', 'switch-size')).toBe(false);
  });

  it('reports a (file, rule) exemption as stale when its finding no longer fires', () => {
    // An empty matched set means nothing an exemption was written for fired —
    // every exemption is stale. This is the SKIP_RULES failure mode: a
    // suppression outliving the finding it suppressed.
    const all = staleExemptions(new Set());
    expect(all.length).toBe(3);
    expect(all).toContainEqual({ file: 'languages/RuntimeManager.ts', rule: 'solid/open-closed' });
    expect(all).toContainEqual({ file: 'languages/go/analyzer-src/parser.go', rule: 'switch-size' });
    expect(all).toContainEqual({ file: 'languages/go/parser/go-ast-parser.go', rule: 'switch-size' });

    // When every exemption is still load-bearing, none is stale.
    const matched = new Set([
      scopedExemptionKey('languages/RuntimeManager.ts', 'solid/open-closed'),
      scopedExemptionKey('languages/go/analyzer-src/parser.go', 'switch-size'),
      scopedExemptionKey('languages/go/parser/go-ast-parser.go', 'switch-size'),
    ]);
    expect(staleExemptions(matched)).toEqual([]);
  });

  it('strips the /src/ prefix to a repo-relative path', () => {
    expect(scopedPath('/app/src/analyzers/a.ts')).toBe('analyzers/a.ts');
    expect(scopedPath('/app/src/languages/go/x.go')).toBe('languages/go/x.go');
    expect(scopedPath('/app/scripts/x.mjs')).toBeNull();
  });
});

describe('verify:disk-space — liveness', () => {
  it('exits 1 when free space is below the threshold', () => {
    const res = spawnSync('node', [join(APP_ROOT, 'scripts', 'verify-disk-space.mjs')], {
      encoding: 'utf-8',
      env: { ...process.env, VERIFY_MIN_FREE_BYTES: '1' + '0'.repeat(30) },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('insufficient disk');
  });
});

describe('verify:gate-budget — liveness', () => {
  // Requires the compiled CLI; skip in a bare test run without a build. In the
  // release path `verify:dist-fresh` has already asserted dist is fresh.
  it.skipIf(!existsSync(DIST_CLI))('exits 1 when the warm gate exceeds the budget', () => {
    const res = spawnSync('node', [join(APP_ROOT, 'scripts', 'verify-gate-budget.mjs')], {
      encoding: 'utf-8',
      env: { ...process.env, VERIFY_GATE_BUDGET_MS: '0' },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('exceeds budget');
  }, 30_000);
});

describe('assert_compatible — liveness', () => {
  /** Source hook-common.sh, call `assert_compatible` against a fake `--version` bin, return the result. */
  function runAssertCompatible(fakeVersion: string | null): { status: number; stdout: string; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), 'ca-assert-compat-'));
    try {
      writeFileSync(join(dir, 'plugin.json'), '{"version":"9.9.9"}');
      const bin = join(dir, 'fakebin');
      if (fakeVersion === null) {
        writeFileSync(bin, '#!/usr/bin/env bash\nexit 0\n');
      } else {
        writeFileSync(bin, `#!/usr/bin/env bash\n[ "$1" = "--version" ] && echo "${fakeVersion}"\nexit 0\n`);
      }
      chmodSync(bin, 0o755);
      const script = `source "${HOOK_COMMON}"\nassert_compatible "${bin}"\necho "RESULT=$?"\n`;
      const res = spawnSync('bash', ['-c', script], {
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: dir },
      });
      const match = /RESULT=(\d+)/.exec(res.stdout ?? '');
      return { status: match ? Number(match[1]) : -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('rejects a CLI whose version mismatches the plugin (non-zero)', () => {
    const { status } = runAssertCompatible('1.0.0');
    expect(status).toBe(1);
  });

  it('rejects an unidentified binary (empty --version) (non-zero)', () => {
    const { status } = runAssertCompatible(null);
    expect(status).toBe(1);
  });

  it('accepts a CLI whose version matches the plugin (zero)', () => {
    const { status } = runAssertCompatible('9.9.9');
    expect(status).toBe(0);
  });
});

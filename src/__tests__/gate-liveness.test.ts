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
 * Five gates are tested here:
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
 *   - `verify:recall-value-drift` — the count/pair comparison in
 *     `verify-recall-value-drift-core.mjs`, the pure half of the Spec 67
 *     follow-up gate (the corpus is absent in CI, so its I/O half SKIPs there;
 *     the failure branch is the comparison itself).
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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
import {
  extractDriftPairs,
  compareToBaseline,
} from '../../scripts/verify-recall-value-drift-core.mjs';
import { compareCompleteness } from '../../scripts/verify-extraction-completeness-core.mjs';
import { compareOracleShortfalls } from '../../scripts/verify-oracle-shortfalls-core.mjs';
import { summarizeResults, GATES } from '../../scripts/verify-close.mjs';

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
    expect(inScope('/app/src/analyzers/universal/UniversalSOLIDAnalyzer.ts', '/app')).toBe(true);
    expect(inScope('/app/src/languages/LanguageRegistry.ts', '/app')).toBe(true);
    // Spec 68 §13.1 — the whole src/ product is in scope, not just analyzers/ + languages/.
    expect(inScope('/app/src/cli.ts', '/app')).toBe(true);
    expect(inScope('/app/src/foo.ts', '/app')).toBe(true);
    // The single declarative data-table exclusion.
    expect(inScope('/app/src/analyzers/ruleRegistry.ts', '/app')).toBe(false);
    // Test corpus + fixture corpora — excluded by directory and by extension.
    expect(inScope('/app/src/analyzers/foo.spec.ts', '/app')).toBe(false);
    expect(inScope('/app/src/analyzers/foo.test.ts', '/app')).toBe(false);
    expect(inScope('/app/src/foo.test-d.ts', '/app')).toBe(false);
    expect(inScope('/app/src/__tests__/x.spec.ts', '/app')).toBe(false);
    expect(inScope('/app/src/analyzers/__tests__/y.ts', '/app')).toBe(false);
    expect(inScope('/app/src/fixtures/z.ts', '/app')).toBe(false);
    // Out-of-tree paths (dev tooling, not the shipped src/ product).
    expect(inScope('/app/scripts/x.mjs', '/app')).toBe(false);
    expect(inScope('/no/src/segment.ts', '/app')).toBe(false);
  });

  it('exempts nothing — Spec 68 §13.1 empties the set, findings are fixed not exempted', () => {
    // The three pre-§68 exemptions keyed on files the Go rework deleted; the
    // set is now empty by design (§13.1) and no finding is absorbed by a
    // suppression.
    expect(isScopedExempt('languages/RuntimeManager.ts', 'solid/open-closed')).toBe(false);
    expect(isScopedExempt('languages/go/analyzer-src/parser.go', 'switch-size')).toBe(false);
    expect(isScopedExempt('analyzers/universal/UniversalSecurityAnalyzer.ts', 'dry/duplicate')).toBe(false);
    expect(isScopedExempt('analyzers/nowhere/Else.ts', 'switch-size')).toBe(false);
  });

  it('reports a (file, rule) exemption as stale when its finding no longer fires', () => {
    // With an empty exemption set there is nothing to go stale: the stale scan
    // over a suppression outliving its finding returns nothing, which is the
    // SKIP_RULES failure mode inverted — an empty map can never accumulate dead
    // entries. The branch is still exercised (it iterates the map and filters),
    // it just has no entries to name.
    expect(staleExemptions(new Set())).toEqual([]);
    expect(staleExemptions(new Set([scopedExemptionKey('x.ts', 'r')]))).toEqual([]);
  });

  it('strips the /src/ prefix to a repo-relative path', () => {
    expect(scopedPath('/app/src/analyzers/a.ts', '/app')).toBe('analyzers/a.ts');
    expect(scopedPath('/app/src/languages/go/x.go', '/app')).toBe('languages/go/x.go');
    expect(scopedPath('/app/src/cli.ts', '/app')).toBe('cli.ts');
    expect(scopedPath('/app/scripts/x.mjs', '/app')).toBeNull();
    expect(scopedPath('/no/src/segment.ts', '/app')).toBeNull();
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

describe('verify:dist-fresh — liveness', () => {
  // A stale dist/cli.js must fail the gate through its own exit 1, never pass by
  // accident. This is the antidote to "the gate happened to be fresh when I ran
  // it": it proves the failure branch is live by making dist stale on purpose
  // (backdating dist/cli.js so every source input is newer than it), then asserts
  // the real gate exits non-zero. Requires the compiled CLI; skip in a bare test
  // run without a build — in the release path `verify:dist-fresh` has already
  // asserted dist is fresh before any test runs.
  it.skipIf(!existsSync(DIST_CLI))('exits 1 when dist/cli.js is older than a source input', () => {
    const before = statSync(DIST_CLI);
    utimesSync(DIST_CLI, 0, 0);
    try {
      const res = spawnSync('node', [join(APP_ROOT, 'scripts', 'verify-dist-fresh.mjs')], {
        encoding: 'utf-8',
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('dist/cli.js is older than');
    } finally {
      utimesSync(DIST_CLI, before.atimeMs / 1000, before.mtimeMs / 1000);
    }
  });
});

describe('assert_compatible — liveness', () => {
  /** Source hook-common.sh, call `assert_compatible` against a fake `--version` bin, return the result. */
  function runAssertCompatible(fakeVersion: string | null): { status: number; stdout: string; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), 'ca-assert-compat-'));
    try {
      // plugin_root() honors CLAUDE_PLUGIN_ROOT only when it points at a real
      // plugin (it must contain scripts/hook-common.sh); give the temp dir that
      // file so the override takes and plugin_version reads this dir's
      // plugin.json (9.9.9), not the source tree's.
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      writeFileSync(join(dir, 'scripts', 'hook-common.sh'), '');
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

describe('verify:recall-value-drift — liveness', () => {
  // The recall-protocol value-drift gate reads its baseline from a JSON file and
  // re-measures the corpus each run; the corpus is absent in CI, so the gate
  // SKIPs there. The failure branch lives in the pure comparison, which is what
  // this tests: a moved count or a changed pair must produce drift lines (and so
  // a non-zero exit), never a silent green.
  const baseline = {
    corpus: 'recall-protocol',
    rule: 'styles/value-drift',
    expectedCount: 3,
    pairs: [
      { drift: '#cfe2ee', canonical: '#cfe0ef', deltaE76: '1.82' },
      { drift: '#637688', canonical: '#5f7488', deltaE76: '1.59' },
      { drift: '#06121a', canonical: '#06131c', deltaE76: '1.06' },
    ],
  };

  it('extracts drift pairs from a real finding message and ignores other rules', () => {
    const violations = [
      {
        rule: 'styles/value-drift',
        message: 'Color drift in "color": "#cfe2ee" is near-identical to "#cfe0ef" (used 1 time, ΔE = 1.82). Consider using "#cfe0ef".',
      },
      { rule: 'styles/off-scale', message: 'Value "13px" is off the Tailwind spacing scale.' },
    ];
    expect(extractDriftPairs(violations)).toEqual([
      { drift: '#cfe2ee', canonical: '#cfe0ef', deltaE76: '1.82' },
    ]);
  });

  it('is green when count and pairs match the baseline exactly', () => {
    const actual = baseline.pairs.map((p) => ({ ...p }));
    expect(compareToBaseline(actual, baseline)).toEqual([]);
  });

  it('reports a moved count', () => {
    const actual = baseline.pairs.map((p) => ({ ...p })).slice(0, 2); // 2, not 3
    expect(compareToBaseline(actual, baseline)).toContain('value-drift count 2 != baseline 3');
  });

  it('reports a changed pair (drift color, canonical, or ΔE)', () => {
    const actual = baseline.pairs.map((p) => ({ ...p }));
    actual[0] = { drift: '#cfe2ee', canonical: '#cfe0ef', deltaE76: '2.50' }; // ΔE moved
    const drift = compareToBaseline(actual, baseline);
    expect(drift.some((d) => d.startsWith('missing pair') || d.startsWith('extra pair'))).toBe(true);
  });
});

describe('verify:extraction-completeness — liveness', () => {
  // The residual gap gate re-measures the corpora each run; the corpus is absent
  // in CI, so the gate SKIPs there. The failure branch lives in the pure
  // comparison — a moved gap, a missing corpus, or an unexpected corpus must
  // produce drift lines (and so a non-zero exit), never a silent green.
  const baseline = { 'hhra-org': 24, blitz: 4, openstatus: 67, 'recall-protocol': 98 };

  it('is green when every corpus gap matches the baseline exactly', () => {
    expect(compareCompleteness({ ...baseline }, baseline)).toEqual([]);
  });

  it('reports a moved gap', () => {
    expect(compareCompleteness({ ...baseline, 'hhra-org': 23 }, baseline)).toContain(
      'corpus hhra-org gap 23 != baseline 24',
    );
  });

  it('reports a corpus the gate failed to measure', () => {
    const { 'hhra-org': _dropped, ...rest } = baseline;
    expect(compareCompleteness(rest, baseline)).toContain(
      'corpus hhra-org not measured (baseline 24)',
    );
  });

  it('reports an unexpected corpus measured beyond the baseline', () => {
    expect(compareCompleteness({ ...baseline, 'new-corpus': 5 }, baseline)).toContain(
      'unexpected corpus new-corpus measured (gap 5)',
    );
  });
});

describe('verify:close — run-all (no gate skips another)', () => {
  // The pre-fix `verify:close` was a single `&&` conjunction: the first failing
  // gate aborted the run and every later gate was silently skipped. A stale
  // `dist/cli.js` made `verify:dist-fresh` exit 1, so `verify:oracle-shortfalls`
  // (and the other drift gates) never ran and their drift sat concealed. The
  // follow-on runner reintroduced a skip — dist-consuming gates were skipped when
  // dist-fresh failed — which is the same defect shape in a softer form. The fix
  // (Spec 70 §chain-honesty) is: a stale dist *fails* the chain through
  // `verify:dist-fresh`'s own exit 1, but no gate ever skips another. Every gate
  // runs and every result is reported, under any condition.

  it('lists every gate exactly once — none can be dropped by an earlier failure', () => {
    expect(GATES).toHaveLength(15);
    expect(new Set(GATES).size).toBe(GATES.length);
  });

  it('orders verify:dist-fresh before the gates that consume dist', () => {
    const distFresh = GATES.indexOf('verify:dist-fresh');
    expect(distFresh).toBeGreaterThan(-1);
    for (const name of [
      'verify:gate-budget',
      'test',
      'test:integration',
      'verify:dist',
      'verify:self',
      'verify:daemon-smoke',
    ]) {
      expect(GATES.indexOf(name)).toBeGreaterThan(distFresh);
    }
  });
});

describe('verify:close — a stale dist fails the chain', () => {
  // Directive 5's other half. "run-all, no skips" (above) proves no gate is ever
  // skipped; this proves the *failure* half end to end — a stale dist/cli.js makes
  // `verify:close` exit non-zero through the real runner, not a report that dist
  // happened to be fresh. `VERIFY_CLOSE_GATES` narrows the run to the single
  // `verify:dist-fresh` gate so the test stays fast, but that gate is the real one:
  // it runs against the backdated dist, exits 1, and the runner propagates it.
  it.skipIf(!existsSync(DIST_CLI))('exits non-zero when verify:dist-fresh fails on a stale dist', () => {
    const before = statSync(DIST_CLI);
    utimesSync(DIST_CLI, 0, 0);
    try {
      const res = spawnSync('node', [join(APP_ROOT, 'scripts', 'verify-close.mjs')], {
        encoding: 'utf-8',
        env: { ...process.env, VERIFY_CLOSE_GATES: 'verify:dist-fresh' },
      });
      expect(res.status).not.toBe(0);
      expect(res.stdout).toContain('FAIL');
      expect(res.stdout).toContain('verify:dist-fresh');
    } finally {
      utimesSync(DIST_CLI, before.atimeMs / 1000, before.mtimeMs / 1000);
    }
  }, 30_000);
});

describe('verify:close — a subset run never reads as a full pass', () => {
  // `VERIFY_CLOSE_GATES` is a test seam, but it must never let a subset run print
  // the release banner. "verify:close PASSED — every gate ran and passed" is
  // reserved for the full 15: a reader or a script seeing that banner must be
  // able to trust it means fifteen. A subset run instead names the gates it ran,
  // states the number omitted, and ends with a clearly-different subset line.
  // This proves the *pass* path — a single always-green gate, forced to pass via
  // `VERIFY_MIN_FREE_BYTES=0` — must not produce the banner.
  it('prints a subset summary and omits the release banner', () => {
    const res = spawnSync('node', [join(APP_ROOT, 'scripts', 'verify-close.mjs')], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        VERIFY_CLOSE_GATES: 'verify:disk-space',
        VERIFY_MIN_FREE_BYTES: '0',
      },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('SUBSET');
    expect(res.stdout).toContain('1 of 15');
    expect(res.stdout).toContain('14 omitted');
    expect(res.stdout).not.toContain('every gate ran and passed');
  }, 30_000);
});

describe('verify:close — run-all verdict (a failed gate fails the chain)', () => {
  // Every gate has run (there is no skip path), so the verdict is pass iff every
  // status is 0. A FAIL or CRASH anywhere fails the chain, and a stale dist is
  // surfaced as `verify:dist-fresh` FAIL alongside every other gate's result.

  const run = (name: string, status: number | null) => ({ name, status });

  it('passes only when every gate ran and exited 0', () => {
    const results = GATES.map((g) => run(g, 0));
    expect(summarizeResults(results).verdict).toBe('pass');
  });

  it('fails when a gate failed (even when every other gate passed)', () => {
    const results = [run('verify:disk-space', 0), run('verify:types', 1)];
    expect(summarizeResults(results).verdict).toBe('fail');
  });

  it('fails when a gate crashed (status null)', () => {
    const results = [run('verify:types', null)];
    expect(summarizeResults(results).verdict).toBe('fail');
  });

  it('reports a crash in crashed (not failed) — no double-count', () => {
    const s = summarizeResults([run('verify:types', null)]);
    expect(s.crashed).toHaveLength(1);
    expect(s.failed).toHaveLength(0);
  });
});

describe('verify:oracle-shortfalls — liveness', () => {
  // The aggregate shortfall gate (Spec 69 R1 criterion 4) re-measures the
  // corpora each run; the corpus is absent in CI, so the gate SKIPs there. The
  // failure branch lives in the pure comparison — a moved files/expected/actual
  // counter, a missing (kind, corpus), or an unexpected one must produce drift
  // lines (and so a non-zero exit), never a silent green.
  const baselineKinds = {
    'file-symbols': {
      composition: 'methods fold into their class symbol',
      corpora: {
        'recall-protocol': { files: 99, expected: 1847, actual: 1338 },
      },
    },
    'batch-functions': {
      composition: 'functions with no .batch( call',
      corpora: {
        'recall-protocol': { files: 1431, expected: 15153, actual: 16 },
      },
    },
  };

  it('is green when every (kind, corpus) aggregate matches the baseline exactly', () => {
    const measured = {
      'file-symbols': { 'recall-protocol': { files: 99, expected: 1847, actual: 1338 } },
      'batch-functions': { 'recall-protocol': { files: 1431, expected: 15153, actual: 16 } },
    };
    expect(compareOracleShortfalls(measured, baselineKinds)).toEqual([]);
  });

  it('reports a moved counter (expected units moved)', () => {
    const measured = {
      'file-symbols': { 'recall-protocol': { files: 99, expected: 1846, actual: 1338 } },
      'batch-functions': { 'recall-protocol': { files: 1431, expected: 15153, actual: 16 } },
    };
    expect(compareOracleShortfalls(measured, baselineKinds)).toContain(
      'file-symbols on recall-protocol expected 1846 != baseline 1847',
    );
  });

  it('marks an actual decrease as a producer regression, not drift', () => {
    const measured = {
      'file-symbols': { 'recall-protocol': { files: 99, expected: 1847, actual: 1200 } },
      'batch-functions': { 'recall-protocol': { files: 1431, expected: 15153, actual: 16 } },
    };
    expect(compareOracleShortfalls(measured, baselineKinds)).toContain(
      'REGRESSION file-symbols on recall-protocol actual 1200 < baseline 1338 (producer emitted fewer facts than its last recording — a defect until attributed)',
    );
  });

  it('does not mark an actual increase as a regression', () => {
    const measured = {
      'file-symbols': { 'recall-protocol': { files: 99, expected: 1847, actual: 1400 } },
      'batch-functions': { 'recall-protocol': { files: 1431, expected: 15153, actual: 16 } },
    };
    expect(compareOracleShortfalls(measured, baselineKinds)).toContain(
      'file-symbols on recall-protocol actual 1400 != baseline 1338',
    );
  });

  it('reports a (kind, corpus) the gate failed to measure', () => {
    const measured = {
      'batch-functions': { 'recall-protocol': { files: 1431, expected: 15153, actual: 16 } },
    };
    expect(compareOracleShortfalls(measured, baselineKinds)).toContain(
      'file-symbols on recall-protocol not measured (baseline files 99, expected 1847, actual 1338)',
    );
  });

  it('reports an unexpected (kind, corpus) measured beyond the baseline', () => {
    const measured = {
      'file-symbols': {
        'recall-protocol': { files: 99, expected: 1847, actual: 1338 },
        openstatus: { files: 65, expected: 830, actual: 437 },
      },
      'batch-functions': { 'recall-protocol': { files: 1431, expected: 15153, actual: 16 } },
    };
    expect(compareOracleShortfalls(measured, baselineKinds)).toContain(
      'unexpected file-symbols on openstatus measured (files 65, expected 830, actual 437)',
    );
  });
});

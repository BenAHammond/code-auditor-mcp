/**
 * Unit tests for path profile resolution (Spec-20).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { resolvePathProfile, PathProfile, ResolvedProfile } from '../config/pathProfiles.js';
import { validateConfig } from '../config/configLoader.js';
import { mergePathProfiles, BUILTIN_PATH_PROFILES } from '../config/defaults.js';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { runAudit } from '../auditRunner.js';
import type { AuditConfig } from '../types.js';

const PROJECT_ROOT = '/Users/test/project';

describe('resolvePathProfile', () => {
  const profiles: PathProfile[] = [
    {
      name: 'source-strict',
      paths: ['src/**'],
      overrides: { requireFunctionDocs: true, maxLinesPerMethod: 50 },
    },
    {
      name: 'scripts-lenient',
      paths: ['scripts/**'],
      overrides: { severityCap: 'suggestion', requireFunctionDocs: true },
    },
    {
      name: 'tests-override',
      paths: ['src/__tests__/**'],
      overrides: { severityCap: 'warning', maxLinesPerMethod: 100 },
    },
  ];

  // Test 1: Single profile match applies overrides
  it('applies overrides from a single matching profile', () => {
    const result = resolvePathProfile(
      `${PROJECT_ROOT}/src/utils/helper.ts`,
      PROJECT_ROOT,
      profiles,
    );
    expect(result.overrides).toEqual({ requireFunctionDocs: true, maxLinesPerMethod: 50 });
    expect(result.severityCap).toBeUndefined();
    expect(result.matchedProfileNames).toEqual(['source-strict']);
  });

  // Test 2: No match returns empty
  it('returns empty overrides when no profile matches', () => {
    const result = resolvePathProfile(
      `${PROJECT_ROOT}/docs/readme.md`,
      PROJECT_ROOT,
      profiles,
    );
    expect(result.overrides).toEqual({});
    expect(result.severityCap).toBeUndefined();
    expect(result.matchedProfileNames).toEqual([]);
  });

  // Test 3: Later wins merge — conflicts resolved to last matching profile
  it('later matching profiles win on conflict', () => {
    const result = resolvePathProfile(
      `${PROJECT_ROOT}/src/__tests__/foo.test.ts`,
      PROJECT_ROOT,
      profiles,
    );
    // source-strict sets maxLinesPerMethod: 50, tests-override sets maxLinesPerMethod: 100
    expect(result.overrides.maxLinesPerMethod).toBe(100);
    // severityCap comes from tests-override (later wins over source-strict which had none)
    expect(result.severityCap).toBe('warning');
    // requireFunctionDocs is set by source-strict, also set by scripts-lenient (but
    // scripts-lenient doesn't match), so source-strict's value persists
    expect(result.overrides.requireFunctionDocs).toBe(true);
    // Both profiles match
    expect(result.matchedProfileNames).toEqual(['source-strict', 'tests-override']);
  });

  // Test 4: severityCap extracted, not in overrides
  it('extracts severityCap separately, not in overrides', () => {
    const result = resolvePathProfile(
      `${PROJECT_ROOT}/scripts/deploy.ts`,
      PROJECT_ROOT,
      [
        { name: 'scripts', paths: ['scripts/**'], overrides: { severityCap: 'suggestion', requireFunctionDocs: true } },
      ],
    );
    expect(result.severityCap).toBe('suggestion');
    expect(result.overrides).toEqual({ requireFunctionDocs: true });
    expect('severityCap' in result.overrides).toBe(false);
  });

  // Test 5: Glob patterns work via picomatch
  it('matches glob patterns correctly', () => {
    // **/ glob
    expect(
      resolvePathProfile(`${PROJECT_ROOT}/src/deep/nested/file.ts`, PROJECT_ROOT, [
        { name: 'all-src', paths: ['src/**'], overrides: { check: true } },
      ]).matchedProfileNames,
    ).toEqual(['all-src']);

    // Exact match
    expect(
      resolvePathProfile(`${PROJECT_ROOT}/index.ts`, PROJECT_ROOT, [
        { name: 'root', paths: ['index.ts'], overrides: { check: true } },
      ]).matchedProfileNames,
    ).toEqual(['root']);

    // Wildcard match
    expect(
      resolvePathProfile(`${PROJECT_ROOT}/foo.test.ts`, PROJECT_ROOT, [
        { name: 'tests', paths: ['*.test.*'], overrides: { check: true } },
      ]).matchedProfileNames,
    ).toEqual(['tests']);
  });

  // Test 6: matchedProfileNames includes all matching profiles in order
  it('records all matching profile names in order', () => {
    const allMatchProfiles: PathProfile[] = [
      { name: 'first', paths: ['src/**'], overrides: { a: 1 } },
      { name: 'second', paths: ['src/**'], overrides: { b: 2 } },
      { name: 'third', paths: ['src/**'], overrides: { c: 3 } },
    ];
    const result = resolvePathProfile(
      `${PROJECT_ROOT}/src/file.ts`,
      PROJECT_ROOT,
      allMatchProfiles,
    );
    expect(result.matchedProfileNames).toEqual(['first', 'second', 'third']);
    expect(result.overrides).toEqual({ a: 1, b: 2, c: 3 });
  });
});

describe('validateConfig — pathProfiles', () => {
  const baseConfig: AuditConfig = {
    includePaths: ['**/*.ts'],
    excludePaths: [],
    enabledAnalyzers: ['solid'],
    outputFormats: ['json'],
    outputDirectory: './reports',
    minSeverity: 'suggestion',
    failOnCritical: false,
    showProgress: false,
  };

  // Test 15: Invalid severityCap value
  it('rejects invalid severityCap values', () => {
    const config: AuditConfig = {
      ...baseConfig,
      pathProfiles: [
        { name: 'bad', paths: ['src/**'], overrides: { severityCap: 'sugession' } },
      ],
    };
    const errors = validateConfig(config);
    const capErrors = errors.filter(e => e.includes('severityCap'));
    expect(capErrors.length).toBeGreaterThan(0);
    expect(capErrors[0]).toContain('sugession');
  });

  it('accepts valid severityCap values', () => {
    const config: AuditConfig = {
      ...baseConfig,
      pathProfiles: [
        { name: 'good', paths: ['src/**'], overrides: { severityCap: 'warning' } },
      ],
    };
    const errors = validateConfig(config);
    expect(errors).toEqual([]);
  });

  // Test 16: Duplicate profile names
  it('rejects duplicate profile names', () => {
    const config: AuditConfig = {
      ...baseConfig,
      pathProfiles: [
        { name: 'dup', paths: ['src/**'], overrides: {} },
        { name: 'dup', paths: ['lib/**'], overrides: {} },
      ],
    };
    const errors = validateConfig(config);
    expect(errors.some(e => e.includes('Duplicate'))).toBe(true);
  });

  // Test 17: Empty paths array
  it('rejects profiles with empty paths array', () => {
    const config: AuditConfig = {
      ...baseConfig,
      pathProfiles: [
        { name: 'no-paths', paths: [], overrides: {} },
      ],
    };
    const errors = validateConfig(config);
    expect(errors.some(e => e.includes('paths') && e.includes('non-empty'))).toBe(true);
  });

  // Test 18: Unknown profile key
  it('rejects unknown profile keys', () => {
    const config: AuditConfig = {
      ...baseConfig,
      pathProfiles: [
        { name: 'bad-key', paths: ['src/**'], overrides: {}, randomField: 42 as any },
      ],
    };
    const errors = validateConfig(config);
    expect(errors.some(e => e.includes('Unknown key') && e.includes('randomField'))).toBe(true);
  });

  // Test 19: Invalid overrides type
  it('rejects non-object overrides', () => {
    const config: AuditConfig = {
      ...baseConfig,
      pathProfiles: [
        { name: 'bad-overrides', paths: ['src/**'], overrides: 'not-an-object' as any },
      ],
    };
    const errors = validateConfig(config);
    expect(errors.some(e => e.includes('overrides') && e.includes('object'))).toBe(true);
  });
});

describe('mergePathProfiles', () => {
  it('returns built-in profiles when no user profiles provided', () => {
    const result = mergePathProfiles(undefined, undefined);
    expect(result).toEqual(BUILTIN_PATH_PROFILES);
  });

  it('disables all built-in profiles when builtin is false', () => {
    const result = mergePathProfiles(undefined, false);
    expect(result).toBeUndefined();
  });

  it('disables built-ins when builtin is false even with user profiles', () => {
    const userProfiles: PathProfile[] = [
      { name: 'custom', paths: ['src/**'], overrides: { requireFunctionDocs: true } },
    ];
    const result = mergePathProfiles(userProfiles, false);
    expect(result).toEqual(userProfiles);
  });

  it('replaces built-in profile when user profile has same name with builtin: false', () => {
    const userProfiles: PathProfile[] = [
      { name: 'scripts-and-tests', paths: ['custom/**'], overrides: { severityCap: 'critical' }, builtin: false },
    ];
    const result = mergePathProfiles(userProfiles, undefined);
    // Should have the user's scripts-and-tests, not the built-in
    const profile = result?.find(p => p.name === 'scripts-and-tests');
    expect(profile?.paths).toEqual(['custom/**']);
    expect(profile?.overrides).toEqual({ severityCap: 'critical' });
    // Should not have any built-in profiles
    expect(result?.length).toBe(1);
  });

  it('merges user profiles after built-ins (later wins)', () => {
    const userProfiles: PathProfile[] = [
      { name: 'custom', paths: ['src/**'], overrides: { requireFunctionDocs: true } },
    ];
    const result = mergePathProfiles(userProfiles, undefined);
    expect(result).toBeDefined();
    // Built-in comes first, user profiles appended after
    expect(result![0].name).toBe('scripts-and-tests');
    expect(result![1].name).toBe('custom');
  });
});

// ============================================================================
// Integration tests — end-to-end with the audit runner
// ============================================================================

const EXPORTED_FN_SRC = `
export function undocumentedFn(items: number[]): number {
  let total = 0;
  for (const item of items) {
    total += item * 1.1;
  }
  return total;
}
`;

/**
 * Helper: pass a promodoc override to elevate documentation violations
 * above the default 'suggestion' so severityCap is observable.
 */
const PROMOTE_DOCS_TO_CRITICAL = { 'function-documentation': 'critical' as const };

describe('pathProfiles — integration', () => {
  let testDir: string;

  beforeAll(async () => {
    initializeLanguages();
    await initParsers();
  });

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), 'ca-profile-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // ── helpers ──────────────────────────────────────────────────────────
  function violationsFor(result: any, filePattern: string): any[] {
    return Object.values(result.analyzerResults)
      .flatMap((r: any) => r.violations || [])
      .filter((v: any) => v.file.includes(filePattern));
  }

  // Test 7: Different severity per directory.
  // src/ gets a doc-required profile (no cap); scripts/ gets a cap to
  // suggestion.  We promote docs violations globally to critical so the
  // cap is observable: src → critical, scripts → suggestion.
  it('applies per-directory profile overrides during audit (Test 7)', async () => {
    const srcDir = path.join(testDir, 'src');
    const scriptsDir = path.join(testDir, 'scripts');
    await mkdir(srcDir, { recursive: true });
    await mkdir(scriptsDir, { recursive: true });

    await writeFile(path.join(srcDir, 'module.ts'), EXPORTED_FN_SRC, 'utf-8');
    await writeFile(path.join(scriptsDir, 'deploy.ts'), EXPORTED_FN_SRC, 'utf-8');

    const result = await runAudit({
      projectRoot: testDir,
      enabledAnalyzers: ['documentation'],
      severityOverrides: PROMOTE_DOCS_TO_CRITICAL,
      pathProfiles: [
        { name: 'source-strict', paths: ['src/**'], overrides: { requireFunctionDocs: true } },
        { name: 'scripts-lenient', paths: ['scripts/**'], overrides: { severityCap: 'suggestion' } },
      ],
      showProgress: false,
    });

    const srcV = violationsFor(result, 'src/module.ts');
    const scriptsV = violationsFor(result, 'scripts/deploy.ts');

    expect(srcV.length).toBeGreaterThan(0);
    expect(scriptsV.length).toBeGreaterThan(0);

    // src has no cap → critical (from severityOverrides)
    for (const v of srcV) {
      expect(v.severity).toBe('critical');
      expect(v.profile).toBe('source-strict');
    }
    // scripts is capped to suggestion
    for (const v of scriptsV) {
      expect(v.severity).toBe('suggestion');
      expect(v.profile).toBe('scripts-lenient');
    }
  });

  // Test 8: Invariant violation immune to profile cap.
  // invariants analyzer never receives pathProfiles, so its violations
  // are never capped — they keep their declared severity.
  it('invariant violations are immune to severityCap (Test 8)', async () => {
    await mkdir(path.join(testDir, 'src'), { recursive: true });

    await writeFile(path.join(testDir, 'src', 'banned-import.ts'), `
import { something } from 'forbidden-module';
export function foo() { return something(); }
`, 'utf-8');

    // Write the config including valid invariant rules.
    // The invariants analyzer reads from disk via projectDir/.codeauditor.json
    // when config.rules is empty (its fallback path).
    await writeFile(path.join(testDir, '.codeauditor.json'), JSON.stringify({
      rules: [
        {
          id: 'no-forbidden',
          kind: 'import-ban',
          module: 'forbidden-module',
          message: 'Do not import from forbidden-module',
          severity: 'critical',
        },
      ],
    }, null, 2), 'utf-8');

    const result = await runAudit({
      projectRoot: testDir,
      enabledAnalyzers: ['invariants'],
      showProgress: false,
    });

    const invariantViolations = violationsFor(result, 'banned-import')
      .filter((v: any) => v.analyzer === 'invariants');

    expect(invariantViolations.length).toBeGreaterThan(0);
    for (const v of invariantViolations) {
      expect(v.severity).toBe('critical');
      // Profile must NOT be set (invariants never receive profiles)
      expect(v.profile).toBeUndefined();
    }
  });

  // Test 9: severityCap beats severityOverrides.
  // Global severityOverrides promotes function-documentation to critical,
  // but path profile caps src/** to suggestion.  Cap must win.
  it('severityCap after severityOverrides — cap wins (Test 9)', async () => {
    await mkdir(path.join(testDir, 'src'), { recursive: true });

    await writeFile(path.join(testDir, 'src', 'module.ts'), EXPORTED_FN_SRC, 'utf-8');

    const result = await runAudit({
      projectRoot: testDir,
      enabledAnalyzers: ['documentation'],
      severityOverrides: PROMOTE_DOCS_TO_CRITICAL,
      pathProfiles: [
        { name: 'capped', paths: ['src/**'], overrides: { severityCap: 'suggestion' } },
      ],
      showProgress: false,
    });

    const docsV = violationsFor(result, 'src/module.ts');
    expect(docsV.length).toBeGreaterThan(0);

    // Cap must win — severity is suggestion, not critical
    for (const v of docsV) {
      expect(v.severity).toBe('suggestion');
      expect(v.profile).toBe('capped');
    }
  });

  // Test 10: Baseline fingerprint stable under profile severity cap.
  // severity overrides promote to "critical" → first run sees "critical";
  // second run adds a profile severityCap: "suggestion" → severity drops
  // to "suggestion".  The fingerprint (symbol) MUST stay identical because
  // it is intentionally severity-free.
  it('baseline fingerprint is stable under profile severity cap (Test 10)', async () => {
    await mkdir(path.join(testDir, 'src'), { recursive: true });

    await writeFile(path.join(testDir, 'src', 'module.ts'), EXPORTED_FN_SRC, 'utf-8');

    // Audit 1: promoted to critical, no cap
    const result1 = await runAudit({
      projectRoot: testDir,
      enabledAnalyzers: ['documentation'],
      severityOverrides: PROMOTE_DOCS_TO_CRITICAL,
      showProgress: false,
    });
    const v1 = violationsFor(result1, 'src/module.ts');
    expect(v1.length).toBeGreaterThan(0);
    expect(v1[0].severity).toBe('critical');

    // Audit 2: same promotion, but profile caps to suggestion
    const result2 = await runAudit({
      projectRoot: testDir,
      enabledAnalyzers: ['documentation'],
      severityOverrides: PROMOTE_DOCS_TO_CRITICAL,
      pathProfiles: [
        { name: 'capped', paths: ['src/**'], overrides: { severityCap: 'suggestion' } },
      ],
      showProgress: false,
    });
    const v2 = violationsFor(result2, 'src/module.ts');
    expect(v2.length).toBeGreaterThan(0);
    expect(v2[0].severity).toBe('suggestion');

    // Severities differ
    expect(v1.map((v: any) => v.severity)).not.toEqual(v2.map((v: any) => v.severity));

    // Fingerprints (symbol field) must be identical — severity-free
    expect(v1.map((v: any) => v.symbol).sort())
      .toEqual(v2.map((v: any) => v.symbol).sort());
  });

  // Test 11: Built-in scripts-and-tests profile activates.
  // A file in scripts/ matches the built-in profile and is capped.
  it('built-in scripts-and-tests profile caps to suggestion (Test 11)', async () => {
    await mkdir(path.join(testDir, 'scripts'), { recursive: true });

    await writeFile(path.join(testDir, 'scripts', 'deploy.ts'), EXPORTED_FN_SRC, 'utf-8');

    // Pass no user profiles — just the built-in.
    const result = await runAudit({
      projectRoot: testDir,
      enabledAnalyzers: ['documentation'],
      severityOverrides: PROMOTE_DOCS_TO_CRITICAL,
      pathProfiles: BUILTIN_PATH_PROFILES,
      showProgress: false,
    });

    const scriptsV = violationsFor(result, 'scripts/deploy.ts');
    expect(scriptsV.length).toBeGreaterThan(0);

    // Built-in caps to suggestion
    for (const v of scriptsV) {
      expect(v.severity).toBe('suggestion');
      expect(v.profile).toBe('scripts-and-tests');
    }
  });

  // Test 12: No built-in profile → no cap.
  // With severityOverrides promoting to critical, a scripts/ file should
  // stay at critical when there's no built-in profile.
  it('without built-in profile, scripts violations fire at original severity (Test 12)', async () => {
    await mkdir(path.join(testDir, 'scripts'), { recursive: true });

    await writeFile(path.join(testDir, 'scripts', 'deploy.ts'), EXPORTED_FN_SRC, 'utf-8');

    // No pathProfiles — no cap applies
    const result = await runAudit({
      projectRoot: testDir,
      enabledAnalyzers: ['documentation'],
      severityOverrides: PROMOTE_DOCS_TO_CRITICAL,
      showProgress: false,
    });

    const scriptsV = violationsFor(result, 'scripts/deploy.ts');
    expect(scriptsV.length).toBeGreaterThan(0);

    // Without any profile, severity stays at critical (from overrides)
    for (const v of scriptsV) {
      expect(v.severity).toBe('critical');
      expect(v.profile).toBeUndefined();
    }
  });

  // Test 13: Profile name attribution on findings.
  // When a profile matches, findings get a `profile` field with the name
  // of the last matching profile.
  it('profile name is attributed to findings in audit result (Test 13)', async () => {
    await mkdir(path.join(testDir, 'src'), { recursive: true });

    await writeFile(path.join(testDir, 'src', 'module.ts'), EXPORTED_FN_SRC, 'utf-8');

    const result = await runAudit({
      projectRoot: testDir,
      enabledAnalyzers: ['documentation'],
      pathProfiles: [
        { name: 'source-strict', paths: ['src/**'], overrides: { requireFunctionDocs: true } },
      ],
      showProgress: false,
    });

    const srcV = violationsFor(result, 'src/module.ts');
    expect(srcV.length).toBeGreaterThan(0);
    for (const v of srcV) {
      expect(v.profile).toBe('source-strict');
    }
  });

  // Test 14: config profiles --file equivalent — resolvePathProfile
  // used by the CLI `config profiles --file` command
  it('resolves profiles for a specific file path (Test 14)', async () => {
    const profiles: PathProfile[] = [
      { name: 'source-strict', paths: ['src/**'], overrides: { requireFunctionDocs: true } },
      { name: 'scripts-lenient', paths: ['scripts/**'], overrides: { severityCap: 'suggestion' } },
    ];

    const resolved = resolvePathProfile(
      `${testDir}/src/utils/helper.ts`,
      testDir,
      profiles,
    );

    expect(resolved.matchedProfileNames).toEqual(['source-strict']);
    expect(resolved.overrides).toEqual({ requireFunctionDocs: true });
    expect(resolved.severityCap).toBeUndefined();
  });
});

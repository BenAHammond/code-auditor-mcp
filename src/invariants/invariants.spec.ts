/**
 * Spec 05 — Invariant Rules Engine Tests
 *
 * Covers:
 * - R1: Rule validation (AJV schema, duplicate IDs, unknown fields)
 * - R2: All four rule kinds (violation and non-violation fixtures)
 * - R3: Error cases (bad regex, bad glob, allowFrom+denyFrom together)
 * - Dynamic import and require() detection for import-ban
 * - except behavior for import-ban, allowFrom/denyFrom for call-constraint
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { validateRulesConfig, hasRules } from './ruleValidator.js';
import { checkRules, clearMatcherCache } from './ruleEngine.js';
import type {
  InvariantRule,
  ImportBanRule,
  CallConstraintRule,
  ModuleBoundaryRule,
  NamingRule,
  AstPatternRule,
} from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

let testDir: string;

function fixtureDir(): string {
  const dir = join(tmpdir(), `invariant-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFixture(relativePath: string, content: string): string {
  const full = join(testDir, relativePath);
  mkdirSync(full.substring(0, full.lastIndexOf('/')), { recursive: true });
  writeFileSync(full, content, 'utf-8');
  return relativePath;
}

beforeEach(() => {
  testDir = fixtureDir();
  clearMatcherCache();
});

afterEach(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
});

function makeRule(overrides: Partial<InvariantRule> & { id: string; kind: InvariantRule['kind']; severity: InvariantRule['severity'] }): InvariantRule {
  const base = { ...overrides };
  // Ensure kind-specific required fields have defaults
  switch (base.kind) {
    case 'import-ban':
      return { module: 'banned-lib', ...base } as ImportBanRule;
    case 'call-constraint':
      return { callee: 'myFunc', allowFrom: ['src/**'], ...base } as CallConstraintRule;
    case 'module-boundary':
      return { from: 'src/from/**', to: 'src/to/**', ...base } as ModuleBoundaryRule;
    case 'naming':
      return { path: 'src/**', exports: '^[A-Z]', ...base } as NamingRule;
    case 'ast-pattern':
      return { pattern: 'new Function($$$)', ...base } as AstPatternRule;
  }
}

// ── R1: Rule Validation ──────────────────────────────────────────────────────

describe('ruleValidator', () => {
  describe('structural validation', () => {
    it('accepts a valid rules config', () => {
      const errors = validateRulesConfig({
        rules: [
          {
            id: 'no-banned-lib',
            kind: 'import-ban',
            severity: 'critical',
            module: 'banned-lib',
          },
        ],
      });
      expect(errors).toHaveLength(0);
    });

    it('rejects a config without a rules array', () => {
      const errors = validateRulesConfig({ notRules: [] });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a rule with an invalid kind', () => {
      const errors = validateRulesConfig({
        rules: [{ id: 'r1', kind: 'bogus-kind', severity: 'critical' }],
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a rule missing required fields', () => {
      const errors = validateRulesConfig({
        rules: [{ id: 'r1', kind: 'import-ban', severity: 'critical' }],
      });
      // missing "module"
      expect(errors.some(e => e.message.includes('module'))).toBe(true);
    });

    it('rejects duplicate rule IDs', () => {
      const errors = validateRulesConfig({
        rules: [
          { id: 'dup', kind: 'import-ban', severity: 'critical', module: 'a' },
          { id: 'dup', kind: 'import-ban', severity: 'warning', module: 'b' },
        ],
      });
      expect(errors.some(e => e.ruleId === 'dup' && e.message.includes('Duplicate'))).toBe(true);
    });

    it('rejects call-constraint with both allowFrom and denyFrom', () => {
      const errors = validateRulesConfig({
        rules: [
          {
            id: 'r1',
            kind: 'call-constraint',
            severity: 'critical',
            callee: 'f',
            allowFrom: ['src/**'],
            denyFrom: ['tests/**'],
          },
        ],
      });
      expect(errors.some(e => e.message.includes('both'))).toBe(true);
    });

    it('rejects call-constraint with neither allowFrom nor denyFrom', () => {
      const errors = validateRulesConfig({
        rules: [
          {
            id: 'r1',
            kind: 'call-constraint',
            severity: 'critical',
            callee: 'f',
          },
        ],
      });
      expect(errors.some(e => e.message.includes('neither'))).toBe(true);
    });

    it('rejects invalid regex in naming exports', () => {
      const errors = validateRulesConfig({
        rules: [
          {
            id: 'r1',
            kind: 'naming',
            severity: 'warning',
            path: 'src/**',
            exports: '[invalid',
          },
        ],
      });
      expect(errors.some(e => e.message.includes('regex') || e.message.includes('Invalid'))).toBe(true);
    });

    it('rejects unknown fields on a rule', () => {
      const errors = validateRulesConfig({
        rules: [
          {
            id: 'r1',
            kind: 'import-ban',
            severity: 'critical',
            module: 'banned',
            extraField: 'should not be here',
          },
        ],
      });
      expect(errors.some(e => e.message.includes('Unknown field'))).toBe(true);
    });

    it('allows valid call-constraint with allowFrom only', () => {
      const errors = validateRulesConfig({
        rules: [
          {
            id: 'r1',
            kind: 'call-constraint',
            severity: 'critical',
            callee: 'secretFn',
            allowFrom: ['src/trusted/**'],
          },
        ],
      });
      expect(errors).toHaveLength(0);
    });

    it('allows valid call-constraint with denyFrom only', () => {
      const errors = validateRulesConfig({
        rules: [
          {
            id: 'r1',
            kind: 'call-constraint',
            severity: 'critical',
            callee: 'dangerousFn',
            denyFrom: ['src/public/**'],
          },
        ],
      });
      expect(errors).toHaveLength(0);
    });

    it('validates all five rule kinds in the same config', () => {
      const errors = validateRulesConfig({
        rules: [
          { id: 'r1', kind: 'import-ban', severity: 'critical', module: 'lodash' },
          { id: 'r2', kind: 'call-constraint', severity: 'warning', callee: 'f', allowFrom: ['src/**'] },
          { id: 'r3', kind: 'module-boundary', severity: 'critical', from: 'src/a/**', to: 'src/b/**' },
          { id: 'r4', kind: 'naming', severity: 'suggestion', path: 'src/**', exports: '^I[A-Z]' },
          { id: 'r5', kind: 'ast-pattern', severity: 'critical', pattern: 'new Function($$$)' },
        ],
      });
      expect(errors).toHaveLength(0);
    });

    it('accepts a valid ast-pattern rule', () => {
      const errors = validateRulesConfig({
        rules: [
          {
            id: 'no-new-function',
            kind: 'ast-pattern',
            severity: 'critical',
            pattern: 'new Function($$$)',
          },
        ],
      });
      expect(errors).toHaveLength(0);
    });

    it('accepts ast-pattern with optional language', () => {
      const errors = validateRulesConfig({
        rules: [
          {
            id: 'js-only',
            kind: 'ast-pattern',
            severity: 'warning',
            pattern: 'var $$$',
            language: 'javascript',
          },
        ],
      });
      expect(errors).toHaveLength(0);
    });

    it('accepts ast-pattern with optional path glob', () => {
      const errors = validateRulesConfig({
        rules: [
          {
            id: 'scoped',
            kind: 'ast-pattern',
            severity: 'warning',
            pattern: 'eval($$$)',
            path: 'src/features/**',
          },
        ],
      });
      expect(errors).toHaveLength(0);
    });

    it('rejects ast-pattern with missing pattern field', () => {
      const errors = validateRulesConfig({
        rules: [
          { id: 'r1', kind: 'ast-pattern', severity: 'critical' },
        ],
      });
      expect(errors.some(e => e.message.includes('pattern'))).toBe(true);
    });

    it('rejects ast-pattern with empty pattern', () => {
      const errors = validateRulesConfig({
        rules: [
          { id: 'r1', kind: 'ast-pattern', severity: 'critical', pattern: '' },
        ],
      });
      expect(errors.some(e => e.message.includes('pattern'))).toBe(true);
    });

    it('rejects ast-pattern with invalid language', () => {
      const errors = validateRulesConfig({
        rules: [
          {
            id: 'r1',
            kind: 'ast-pattern',
            severity: 'critical',
            pattern: 'new Function($$$)',
            language: 'python',
          },
        ],
      });
      expect(errors.some(e => e.message.includes('language'))).toBe(true);
    });
  });

  describe('hasRules', () => {
    it('returns true when rules array has items', () => {
      expect(hasRules({ rules: [{ id: 'r1', kind: 'import-ban', severity: 'critical', module: 'x' }] })).toBe(true);
    });

    it('returns false when rules array is empty', () => {
      expect(hasRules({ rules: [] })).toBe(false);
    });

    it('returns false when no rules property', () => {
      expect(hasRules({})).toBe(false);
    });

    it('returns false for non-object', () => {
      expect(hasRules(null)).toBe(false);
      expect(hasRules(undefined)).toBe(false);
    });
  });
});

// ── R2.1: import-ban ─────────────────────────────────────────────────────────

describe('import-ban', () => {
  it('catches static import of a banned module', () => {
    writeFixture('src/bad.ts', `import { something } from 'banned-lib';`);
    const result = checkRules({
      rules: [
        makeRule({ id: 'no-banned', kind: 'import-ban', severity: 'critical', module: 'banned-lib' }),
      ],
      files: ['src/bad.ts'],
      projectDir: testDir,
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].importSpecifier).toBe('banned-lib');
    expect(result.violations[0].kind).toBe('import-ban');
    expect(result.violations[0].severity).toBe('critical');
    expect(result.violations[0].ruleId).toBe('no-banned');
  });

  it('catches dynamic import() of a banned module', () => {
    writeFixture('src/bad.ts', `async function load() { const m = await import('banned-lib'); }`);
    const result = checkRules({
      rules: [
        makeRule({ id: 'no-banned', kind: 'import-ban', severity: 'critical', module: 'banned-lib' }),
      ],
      files: ['src/bad.ts'],
      projectDir: testDir,
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].importSpecifier).toBe('banned-lib');
  });

  it('catches require() of a banned module', () => {
    writeFixture('src/bad.ts', `const x = require('banned-lib');`);
    const result = checkRules({
      rules: [
        makeRule({ id: 'no-banned', kind: 'import-ban', severity: 'critical', module: 'banned-lib' }),
      ],
      files: ['src/bad.ts'],
      projectDir: testDir,
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].importSpecifier).toBe('banned-lib');
  });

  it('allows import when file matches except glob', () => {
    writeFixture('src/exempt/special.ts', `import { x } from 'banned-lib';`);
    const result = checkRules({
      rules: [
        makeRule({
          id: 'no-banned',
          kind: 'import-ban',
          severity: 'critical',
          module: 'banned-lib',
          except: ['src/exempt/**'],
        }),
      ],
      files: ['src/exempt/special.ts'],
      projectDir: testDir,
    });
    expect(result.violations).toHaveLength(0);
  });

  it('still catches import in non-exempt files when except is configured', () => {
    writeFixture('src/exempt/special.ts', `import { x } from 'banned-lib';`);
    writeFixture('src/normal.ts', `import { x } from 'banned-lib';`);
    const result = checkRules({
      rules: [
        makeRule({
          id: 'no-banned',
          kind: 'import-ban',
          severity: 'critical',
          module: 'banned-lib',
          except: ['src/exempt/**'],
        }),
      ],
      files: ['src/exempt/special.ts', 'src/normal.ts'],
      projectDir: testDir,
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].file).toBe('src/normal.ts');
  });

  it('matches module glob patterns', () => {
    writeFixture('src/bad.ts', `import { x } from '@ai-sdk/openai';`);
    const result = checkRules({
      rules: [
        makeRule({
          id: 'no-ai-sdk',
          kind: 'import-ban',
          severity: 'warning',
          module: '@ai-sdk/*',
        }),
      ],
      files: ['src/bad.ts'],
      projectDir: testDir,
    });
    expect(result.violations).toHaveLength(1);
  });

  it('does not flag imports of non-banned modules', () => {
    writeFixture('src/good.ts', `import { ok } from 'allowed-lib';`);
    const result = checkRules({
      rules: [
        makeRule({ id: 'no-banned', kind: 'import-ban', severity: 'critical', module: 'banned-lib' }),
      ],
      files: ['src/good.ts'],
      projectDir: testDir,
    });
    expect(result.violations).toHaveLength(0);
  });

  it('includes the user message in violations', () => {
    writeFixture('src/bad.ts', `import { x } from 'banned';`);
    const result = checkRules({
      rules: [
        makeRule({
          id: 'custom-msg',
          kind: 'import-ban',
          severity: 'suggestion',
          module: 'banned',
          message: 'Do not use banned; prefer our internal wrapper.',
        }),
      ],
      files: ['src/bad.ts'],
      projectDir: testDir,
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].message).toBe('Do not use banned; prefer our internal wrapper.');
  });
});

// ── R2.3: module-boundary ────────────────────────────────────────────────────

describe('module-boundary', () => {
  it('catches an import crossing the from→to boundary', () => {
    writeFixture('src/features/a/index.ts', `export const a = 1;`);
    writeFixture('src/features/b/messy.ts', `import { a } from '../a/index';`);
    const result = checkRules({
      rules: [
        makeRule({
          id: 'no-cross-feature',
          kind: 'module-boundary',
          severity: 'critical',
          from: 'src/features/b/**',
          to: 'src/features/a/**',
        }),
      ],
      files: ['src/features/b/messy.ts'],
      projectDir: testDir,
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].kind).toBe('module-boundary');
    expect(result.violations[0].importSpecifier).toBe('../a/index');
  });

  it('does not flag imports within the same boundary', () => {
    writeFixture('src/features/a/index.ts', `export const a = 1;`);
    writeFixture('src/features/a/child.ts', `import { a } from './index';`);
    const result = checkRules({
      rules: [
        makeRule({
          id: 'no-cross',
          kind: 'module-boundary',
          severity: 'critical',
          from: 'src/features/b/**',
          to: 'src/features/a/**',
        }),
      ],
      files: ['src/features/a/child.ts'],
      projectDir: testDir,
    });
    // The importing file matches neither from nor to, so no violation
    // Actually the from is b/** which doesn't match a/child.ts
    expect(result.violations).toHaveLength(0);
  });

  it('does not flag when from does not match the importing file', () => {
    writeFixture('src/lib/utils.ts', `export const util = 1;`);
    writeFixture('src/features/c/consumer.ts', `import { util } from '../../lib/utils';`);
    const result = checkRules({
      rules: [
        makeRule({
          id: 'no-cross',
          kind: 'module-boundary',
          severity: 'critical',
          from: 'src/features/b/**',
          to: 'src/lib/**',
        }),
      ],
      files: ['src/features/c/consumer.ts'],
      projectDir: testDir,
    });
    // from=src/features/b/** doesn't match src/features/c/consumer.ts
    expect(result.violations).toHaveLength(0);
  });
});

// ── R2.4: naming ─────────────────────────────────────────────────────────────

describe('naming', () => {
  it('catches exported symbol not matching regex', () => {
    writeFixture('src/components/Button.ts', `
export function myComponent() {}
export const helperVar = 42;
`);
    const result = checkRules({
      rules: [
        makeRule({
          id: 'pascal-components',
          kind: 'naming',
          severity: 'warning',
          path: 'src/components/**',
          exports: '^[A-Z]', // must start with uppercase
        }),
      ],
      files: ['src/components/Button.ts'],
      projectDir: testDir,
    });
    // myComponent starts with lowercase; helperVar starts with lowercase
    // Both are violations
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    expect(result.violations.some(v => v.symbol === 'myComponent')).toBe(true);
  });

  it('allows exports that match the regex', () => {
    writeFixture('src/components/NavBar.ts', `
export function NavBar() {}
export const AppHeader = () => null;
`);
    const result = checkRules({
      rules: [
        makeRule({
          id: 'pascal-components',
          kind: 'naming',
          severity: 'warning',
          path: 'src/components/**',
          exports: '^[A-Z]',
        }),
      ],
      files: ['src/components/NavBar.ts'],
      projectDir: testDir,
    });
    // NavBar is capitalized; AppHeader (const) is uppercase
    expect(result.violations).toHaveLength(0);
  });

  it('skips files outside the path glob', () => {
    writeFixture('src/utils/helpers.ts', `
export function formatDate() {}
`);
    const result = checkRules({
      rules: [
        makeRule({
          id: 'pascal-components',
          kind: 'naming',
          severity: 'warning',
          path: 'src/components/**',
          exports: '^[A-Z]',
        }),
      ],
      files: ['src/utils/helpers.ts'],
      projectDir: testDir,
    });
    expect(result.violations).toHaveLength(0);
  });

  it('includes user message in violation', () => {
    writeFixture('src/components/bad.ts', `export function badOne() {}`);
    const result = checkRules({
      rules: [
        makeRule({
          id: 'pascal',
          kind: 'naming',
          severity: 'warning',
          path: 'src/components/**',
          exports: '^[A-Z]',
          message: 'Component exports must be PascalCase.',
        }),
      ],
      files: ['src/components/bad.ts'],
      projectDir: testDir,
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].message).toBe('Component exports must be PascalCase.');
  });
});

// ── R2.2: call-constraint (without DB — the engine still works, uses scoped callers) ──

describe('call-constraint', () => {
  it('produces no violations when no DB is available (graceful skip)', () => {
    writeFixture('src/untrusted.ts', `import { secret } from './lib';`);
    const result = checkRules({
      rules: [
        makeRule({
          id: 'no-external-call',
          kind: 'call-constraint',
          severity: 'critical',
          callee: 'dangerousFn',
          allowFrom: ['src/trusted/**'],
        }),
      ],
      files: ['src/untrusted.ts'],
      projectDir: testDir,
      // No db provided
    });
    // Without DB, scopedCallers is empty, so no violations
    expect(result.violations).toHaveLength(0);
    expect(result.errors).toHaveLength(0); // no error either — graceful skip
  });

  it('parses callee with path glob', () => {
    // Just verify the parseCallee logic doesn't throw
    writeFixture('src/trusted/caller.ts', `export function doWork() {}`);
    const result = checkRules({
      rules: [
        makeRule({
          id: 'no-external',
          kind: 'call-constraint',
          severity: 'critical',
          callee: 'src/lib/**#dangerousFn',
          allowFrom: ['src/trusted/**'],
        }),
      ],
      files: ['src/trusted/caller.ts'],
      projectDir: testDir,
    });
    expect(result.errors).toHaveLength(0);
  });
});

// ── R2.2a: call-constraint with DB (cold-sync enforcement) ──
// Production path: synchronizeFile → scanFunctions → syncFileIndex →
// updateDependencyGraph (populates function_calls) → checkRules reads scopedCallers.
// The pre-existing tests above only covered the graceful-skip path (no DB).
// This test proves that a call-constraint rule actually catches violations
// when the call graph is populated — the load-bearing assertion for a rule
// kind whose whole pitch is "you can trust this to block."

describe('call-constraint enforcement (cold DB)', () => {
  let dbDir: string;
  let db: any;

  beforeEach(async () => {
    const { mkdtemp } = await import('fs/promises');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    dbDir = await mkdtemp(join(tmpdir(), 'ca-call-constraint-'));
    const { CodeIndexDB } = await import('../codeIndexDB.js');
    db = new CodeIndexDB(join(dbDir, 'index.db'));
    await db.initialize();
  });

  afterEach(async () => {
    if (db) await db.close();
    try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('catches a call-constraint violation after cold sync with seeded call data', async () => {
    // Write fixture: a file that calls dangerousFn from outside the allowed path
    writeFixture('src/untrusted/caller.ts', `
export function doUntrustedWork() {
  dangerousFn();
}
`);

    // Simulate what synchronizeFile → FunctionScanner.scanFunctions produces:
    // functions with functionCalls in their metadata.
    await db.registerFunctions([
      {
        name: 'dangerousFn',
        filePath: 'src/lib/secrets.ts',
        signature: 'function dangerousFn()',
        parameters: [],
        dependencies: [],
        purpose: '',
        context: '',
        language: 'typescript',
        lineNumber: 1,
        body: 'function dangerousFn() { doSecret(); }',
        complexity: 1,
        metadata: {
          entityType: 'function',
        },
      },
      {
        name: 'doUntrustedWork',
        filePath: 'src/untrusted/caller.ts',
        signature: 'function doUntrustedWork()',
        parameters: [],
        dependencies: [],
        purpose: '',
        context: '',
        language: 'typescript',
        lineNumber: 2,
        body: 'function doUntrustedWork() { dangerousFn(); }',
        complexity: 1,
        metadata: {
          entityType: 'function',
          functionCalls: ['dangerousFn'],
        },
      },
    ]);

    // Rebuild the call graph — this is what syncFileIndex calls internally at line 1000
    await db.updateDependencyGraph();

    // Now run the rule engine WITH the DB
    const result = checkRules({
      rules: [
        makeRule({
          id: 'no-external-call',
          kind: 'call-constraint',
          severity: 'critical',
          callee: 'dangerousFn',
          allowFrom: ['src/trusted/**'],
        }),
      ],
      files: ['src/untrusted/caller.ts'],
      projectDir: testDir,
      db,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].kind).toBe('call-constraint');
    expect(result.violations[0].ruleId).toBe('no-external-call');
    expect(result.violations[0].file).toBe('src/untrusted/caller.ts');
    expect(result.violations[0].message).toContain('dangerousFn');
  });

  it('produces no violation when caller IS in the allowed path', async () => {
    writeFixture('src/trusted/caller.ts', `
export function doTrustedWork() {
  dangerousFn();
}
`);

    await db.registerFunctions([
      {
        name: 'dangerousFn',
        filePath: 'src/lib/secrets.ts',
        signature: 'function dangerousFn()',
        parameters: [],
        dependencies: [],
        purpose: '',
        context: '',
        language: 'typescript',
        lineNumber: 1,
        body: 'function dangerousFn() { doSecret(); }',
        complexity: 1,
        metadata: { entityType: 'function' },
      },
      {
        name: 'doTrustedWork',
        filePath: 'src/trusted/caller.ts',
        signature: 'function doTrustedWork()',
        parameters: [],
        dependencies: [],
        purpose: '',
        context: '',
        language: 'typescript',
        lineNumber: 2,
        body: 'function doTrustedWork() { dangerousFn(); }',
        complexity: 1,
        metadata: {
          entityType: 'function',
          functionCalls: ['dangerousFn'],
        },
      },
    ]);

    await db.updateDependencyGraph();

    const result = checkRules({
      rules: [
        makeRule({
          id: 'no-external-call',
          kind: 'call-constraint',
          severity: 'critical',
          callee: 'dangerousFn',
          allowFrom: ['src/trusted/**'],
        }),
      ],
      files: ['src/trusted/caller.ts'],
      projectDir: testDir,
      db,
    });

    expect(result.errors).toHaveLength(0);
    // The caller is in src/trusted/**, so it IS allowed
    expect(result.violations).toHaveLength(0);
  });

  it('catches violation with denyFrom when caller is in the denied path', async () => {
    writeFixture('src/ui/component.ts', `
export function renderPage() {
  dangerAPI();
}
`);

    await db.registerFunctions([
      {
        name: 'dangerAPI',
        filePath: 'src/api/unsafe.ts',
        signature: 'function dangerAPI()',
        parameters: [],
        dependencies: [],
        purpose: '',
        context: '',
        language: 'typescript',
        lineNumber: 1,
        body: 'function dangerAPI() { return raw; }',
        complexity: 1,
        metadata: { entityType: 'function' },
      },
      {
        name: 'renderPage',
        filePath: 'src/ui/component.ts',
        signature: 'function renderPage()',
        parameters: [],
        dependencies: [],
        purpose: '',
        context: '',
        language: 'typescript',
        lineNumber: 2,
        body: 'function renderPage() { dangerAPI(); }',
        complexity: 1,
        metadata: {
          entityType: 'function',
          functionCalls: ['dangerAPI'],
        },
      },
    ]);

    await db.updateDependencyGraph();

    const result = checkRules({
      rules: [
        // Don't use makeRule here — it defaults allowFrom which would
        // take precedence over denyFrom in the rule engine.
        {
          id: 'no-ui-api-call',
          kind: 'call-constraint' as const,
          severity: 'critical' as const,
          callee: 'dangerAPI',
          denyFrom: ['src/ui/**'],
        },
      ],
      files: ['src/ui/component.ts'],
      projectDir: testDir,
      db,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].ruleId).toBe('no-ui-api-call');
    expect(result.violations[0].file).toBe('src/ui/component.ts');
  });
});

// ── Mixed rules ──────────────────────────────────────────────────────────────

describe('multiple rules', () => {
  it('checks all rule kinds together', () => {
    writeFixture('src/app.ts', `
import { old } from 'banned-lib';
import { helper } from '../shared/helpers';
export function doThing() {}
`);
    const result = checkRules({
      rules: [
        makeRule({ id: 'no-banned', kind: 'import-ban', severity: 'critical', module: 'banned-lib' }),
        makeRule({ id: 'pascal', kind: 'naming', severity: 'warning', path: 'src/**', exports: '^[A-Z]' }),
      ],
      files: ['src/app.ts'],
      projectDir: testDir,
    });
    // import-ban catches banned-lib
    expect(result.violations.some(v => v.kind === 'import-ban')).toBe(true);
    // naming catches doThing (starts lowercase)
    expect(result.violations.some(v => v.kind === 'naming')).toBe(true);
    expect(result.violations.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty violations when rules array is empty', () => {
    writeFixture('src/ok.ts', `export const OK = 1;`);
    const result = checkRules({
      rules: [],
      files: ['src/ok.ts'],
      projectDir: testDir,
    });
    expect(result.violations).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles non-existent files gracefully', () => {
    const result = checkRules({
      rules: [
        makeRule({ id: 'x', kind: 'import-ban', severity: 'critical', module: 'x' }),
      ],
      files: ['src/nonexistent.ts'],
      projectDir: testDir,
    });
    // Should not crash — file just has no imports
    expect(result.violations).toHaveLength(0);
  });

  it('handles files with syntax errors gracefully', () => {
    writeFixture('src/broken.ts', `this is not valid typescript @@@`);
    const result = checkRules({
      rules: [
        makeRule({ id: 'x', kind: 'import-ban', severity: 'critical', module: 'x' }),
      ],
      files: ['src/broken.ts'],
      projectDir: testDir,
    });
    // Should not crash; TypeScript parser is lenient
    expect(result.errors.length).toBeLessThanOrEqual(1);
  });

  it('normalizes leading ./ in file paths', () => {
    writeFixture('src/file.ts', `import { x } from 'banned-lib';`);
    const result = checkRules({
      rules: [
        makeRule({ id: 'no', kind: 'import-ban', severity: 'critical', module: 'banned-lib' }),
      ],
      files: ['./src/file.ts'],
      projectDir: testDir,
    });
    expect(result.violations).toHaveLength(1);
  });

  it('naming violation includes correct line number', () => {
    writeFixture('src/Component.ts', `
import React from 'react';

// This is a bad export name
export function badCasing() {
  return null;
}
`);
    const result = checkRules({
      rules: [
        makeRule({ id: 'pascal', kind: 'naming', severity: 'warning', path: 'src/**', exports: '^[A-Z]' }),
      ],
      files: ['src/Component.ts'],
      projectDir: testDir,
    });
    const viol = result.violations.find(v => v.symbol === 'badCasing');
    expect(viol).toBeDefined();
    expect(viol!.line).toBeGreaterThan(0);
  });
});

// ── R2.5: ast-pattern ──────────────────────────────────────────────────────────

describe('ast-pattern', () => {
  it('detects a matching AST pattern in source code', () => {
    writeFixture('src/bad.ts', `const fn = new Function("return 1");`);
    const result = checkRules({
      rules: [
        makeRule({
          id: 'no-new-function',
          kind: 'ast-pattern',
          severity: 'critical',
          pattern: 'new Function($$$)',
        }),
      ],
      files: ['src/bad.ts'],
      projectDir: testDir,
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].ruleId).toBe('no-new-function');
    expect(result.violations[0].kind).toBe('ast-pattern');
    expect(result.violations[0].severity).toBe('critical');
    expect(result.violations[0].file).toBe('src/bad.ts');
  });

  it('does not flag files with non-matching patterns', () => {
    writeFixture('src/good.ts', `const add = (a, b) => a + b;`);
    const result = checkRules({
      rules: [
        makeRule({
          id: 'no-new-function',
          kind: 'ast-pattern',
          severity: 'critical',
          pattern: 'new Function($$$)',
        }),
      ],
      files: ['src/good.ts'],
      projectDir: testDir,
    });
    expect(result.violations).toHaveLength(0);
  });

  it('includes the user message in violations', () => {
    writeFixture('src/bad.ts', `const fn = new Function("return 1");`);
    const result = checkRules({
      rules: [
        makeRule({
          id: 'no-eval',
          kind: 'ast-pattern',
          severity: 'warning',
          pattern: 'new Function($$$)',
          message: 'new Function() is eval-by-another-name — forbidden in this codebase',
        }),
      ],
      files: ['src/bad.ts'],
      projectDir: testDir,
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].message).toBe('new Function() is eval-by-another-name — forbidden in this codebase');
  });

  it('provides line and column location in violation', () => {
    writeFixture('src/bad.ts', `const fn = new Function("return 1");`);
    const result = checkRules({
      rules: [
        makeRule({
          id: 'no-new-function',
          kind: 'ast-pattern',
          severity: 'critical',
          pattern: 'new Function($$$)',
        }),
      ],
      files: ['src/bad.ts'],
      projectDir: testDir,
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].line).toBeGreaterThan(0);
    expect(result.violations[0].column).toBeGreaterThan(0);
    expect(result.violations[0].symbol).toBeDefined();
  });

  it('respects path glob filter', () => {
    writeFixture('src/features/a/bad.ts', `const fn = new Function("x");`);
    writeFixture('src/lib/good.ts', `const fn = new Function("x");`);
    const result = checkRules({
      rules: [
        makeRule({
          id: 'no-new-fn-in-features',
          kind: 'ast-pattern',
          severity: 'critical',
          pattern: 'new Function($$$)',
          path: 'src/features/**',
        }),
      ],
      files: ['src/features/a/bad.ts', 'src/lib/good.ts'],
      projectDir: testDir,
    });
    // Only the file matching the path glob should produce a violation
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].file).toBe('src/features/a/bad.ts');
  });

  it('skips files outside the path glob', () => {
    writeFixture('src/utils/safe.ts', `const fn = new Function("x");`);
    const result = checkRules({
      rules: [
        makeRule({
          id: 'no-new-fn-ui',
          kind: 'ast-pattern',
          severity: 'critical',
          pattern: 'new Function($$$)',
          path: 'src/components/**',
        }),
      ],
      files: ['src/utils/safe.ts'],
      projectDir: testDir,
    });
    expect(result.violations).toHaveLength(0);
  });

  it('respects the language setting', () => {
    // JavaScript source should still be matched when language is typescript
    writeFixture('src/bad.js', `var fn = new Function("x");`);
    const result = checkRules({
      rules: [
        makeRule({
          id: 'no-new-function',
          kind: 'ast-pattern',
          severity: 'critical',
          pattern: 'new Function($$$)',
        }),
      ],
      files: ['src/bad.js'],
      projectDir: testDir,
    });
    // Without language specified, defaults to typescript/tsx which handles JS
    expect(result.violations).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  it('handles parse errors gracefully (non-TS content)', () => {
    writeFixture('src/config.json', `{ "key": "value" }`);
    const result = checkRules({
      rules: [
        makeRule({
          id: 'no-new-function',
          kind: 'ast-pattern',
          severity: 'critical',
          pattern: 'new Function($$$)',
        }),
      ],
      files: ['src/config.json'],
      projectDir: testDir,
    });
    // JSON isn't valid TS, but ast-grep should handle it or error gracefully
    expect(result.errors.length).toBeLessThanOrEqual(2); // one error for parse, or none if it handles it
  });

  it('handles multiple ast-pattern rules together', () => {
    writeFixture('src/bad.ts', `const fn = new Function("x");\nconst arr = eval("42");`);
    const result = checkRules({
      rules: [
        makeRule({
          id: 'no-new-function',
          kind: 'ast-pattern',
          severity: 'critical',
          pattern: 'new Function($$$)',
        }),
        makeRule({
          id: 'no-eval',
          kind: 'ast-pattern',
          severity: 'critical',
          pattern: 'eval($$$)',
        }),
      ],
      files: ['src/bad.ts'],
      projectDir: testDir,
    });
    expect(result.violations).toHaveLength(2);
    expect(result.violations.map(v => v.ruleId).sort()).toEqual(['no-eval', 'no-new-function']);
  });

  it('works alongside other rule kinds', () => {
    writeFixture('src/bad.ts', `
import { old } from 'banned-lib';
const fn = new Function("return 1");
export function doThing() {}
`);
    const result = checkRules({
      rules: [
        makeRule({ id: 'no-banned', kind: 'import-ban', severity: 'critical', module: 'banned-lib' }),
        makeRule({ id: 'no-new-fn', kind: 'ast-pattern', severity: 'warning', pattern: 'new Function($$$)' }),
        makeRule({ id: 'pascal', kind: 'naming', severity: 'suggestion', path: 'src/**', exports: '^[A-Z]' }),
      ],
      files: ['src/bad.ts'],
      projectDir: testDir,
    });
    expect(result.violations.some(v => v.kind === 'import-ban')).toBe(true);
    expect(result.violations.some(v => v.kind === 'ast-pattern')).toBe(true);
    expect(result.violations.some(v => v.kind === 'naming')).toBe(true);
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
  });

  it('allows zero matches for a valid pattern', () => {
    writeFixture('src/clean.ts', `const add = (a, b) => a + b;\nconst mul = (a, b) => a * b;`);
    const result = checkRules({
      rules: [
        makeRule({
          id: 'no-debugger',
          kind: 'ast-pattern',
          severity: 'warning',
          pattern: 'debugger',
        }),
      ],
      files: ['src/clean.ts'],
      projectDir: testDir,
    });
    expect(result.violations).toHaveLength(0);
  });
});

// ── Scope behavior ───────────────────────────────────────────────────────────

describe('scoped audit behavior', () => {
  it('only checks the specified files', () => {
    writeFixture('src/a.ts', `import { x } from 'banned-lib';`);
    writeFixture('src/b.ts', `import { x } from 'banned-lib';`);
    const result = checkRules({
      rules: [
        makeRule({ id: 'no', kind: 'import-ban', severity: 'critical', module: 'banned-lib' }),
      ],
      files: ['src/a.ts'], // only check a.ts
      projectDir: testDir,
    });
    // Only a.ts is checked, one violation
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].file).toBe('src/a.ts');
  });

  it('checks all files when multiple are scoped', () => {
    writeFixture('src/a.ts', `import { x } from 'banned-lib';`);
    writeFixture('src/b.ts', `import { y } from 'banned-lib';`);
    const result = checkRules({
      rules: [
        makeRule({ id: 'no', kind: 'import-ban', severity: 'critical', module: 'banned-lib' }),
      ],
      files: ['src/a.ts', 'src/b.ts'],
      projectDir: testDir,
    });
    expect(result.violations).toHaveLength(2);
  });
});

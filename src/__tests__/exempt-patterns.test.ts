/**
 * Gap 4 (DEFECT): exemptPatterns must match file paths only, never symbol names.
 *
 * Before the fix, isExempt() was called on function names (func.name), class names
 * (cls.name), and method names (method.name) — meaning `specialOffer` was incorrectly
 * exempted (contains "spec"), `MockDataService` was exempted (contains "mock"), etc.
 *
 * After the fix, only file paths are matched. Fixtures verify both directions:
 *   A) foo.spec.ts — exempt because file path matches '\.spec\.'
 *   B) specialOffer() in production.ts — NOT exempt (exemptPatterns are file-only)
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';

import { initializeLanguages, initParsers } from '../languages/index.js';
import { runAudit } from '../auditRunner.js';

// The fixture functions must be >= 5 body lines for the default docsMinLines gate.
// specialOffer is 7 body lines — passes gate.

const SPECIAL_OFFER_FUNCTION = `// Production file — "specialOffer" contains "spec" but is NOT exempt
// because exemptPatterns only match file paths, not function names.
export function specialOffer(n: number): string {
  const x = n * 2;
  const y = x + 1;
  const z = y * 3;
  const result = String(z);
  return result;
}
`;

const TEST_HELPER_FUNCTION = `// Test file — exempt because file path matches '\\.spec\\.'.
export function testHelper(): string {
  const a = "hello";
  const b = a + " world";
  const c = b.toUpperCase();
  const d = c + "!";
  return d;
}
`;

describe('exemptPatterns — file paths only (Gap 4)', () => {
  let testDir: string;

  beforeAll(async () => {
    initializeLanguages();
    await initParsers();
  });

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), 'ca-exempt-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('files matching \\.spec\\. are exempt from documentation checks', async () => {
    // Setup: create a .spec.ts file with an undocumented exported function
    const srcDir = path.join(testDir, 'src');
    await mkdir(srcDir, { recursive: true });
    const specFile = path.join(srcDir, 'foo.spec.ts');
    await writeFile(specFile, TEST_HELPER_FUNCTION, 'utf-8');

    // Run audit with explicit file scope — use individual files, not globs
    const result = await runAudit({
      projectRoot: testDir,
      enabledAnalyzers: ['documentation'],
      showProgress: false,
      scope: [specFile],
    });

    const violations = Object.values(result.analyzerResults).flatMap(
      (r: any) => r.violations || [],
    );

    // foo.spec.ts should be exempt because its file path matches '\.spec\.'
    const fromSpecFile = violations.filter((v: any) => v.file && v.file.includes('foo.spec.ts'));
    expect(fromSpecFile).toHaveLength(0);
  });

  it('functions with names matching exemptPatterns substrings are NOT exempt', async () => {
    // Setup: create a production file with function named "specialOffer"
    const srcDir = path.join(testDir, 'src');
    await mkdir(srcDir, { recursive: true });
    const prodFile = path.join(srcDir, 'production.ts');
    await writeFile(prodFile, SPECIAL_OFFER_FUNCTION, 'utf-8');

    // Run audit programmatically with explicit file scope
    const result = await runAudit({
      projectRoot: testDir,
      enabledAnalyzers: ['documentation'],
      showProgress: false,
      scope: [prodFile],
    });

    const violations = Object.values(result.analyzerResults).flatMap(
      (r: any) => r.violations || [],
    );

    // specialOffer() should NOT be exempt even though "spec" appears in its name
    // The fix ensures exemptPatterns only match file paths
    const docViolations = violations.filter(
      (v: any) => v.analyzer === 'documentation',
    );

    expect(docViolations.length).toBeGreaterThanOrEqual(1);
    const specialOfferV = docViolations.find(
      (v: any) => v.message && v.message.includes('specialOffer'),
    );
    expect(specialOfferV).toBeDefined();
    expect(specialOfferV!.file).toContain('production.ts');
  });

  it('both fixtures together: spec file exempt, production file not exempt', async () => {
    const srcDir = path.join(testDir, 'src');
    await mkdir(srcDir, { recursive: true });
    const specFile = path.join(srcDir, 'foo.spec.ts');
    const prodFile = path.join(srcDir, 'production.ts');
    await writeFile(specFile, TEST_HELPER_FUNCTION, 'utf-8');
    await writeFile(prodFile, SPECIAL_OFFER_FUNCTION, 'utf-8');

    // Use explicit file list — both files
    const result = await runAudit({
      projectRoot: testDir,
      enabledAnalyzers: ['documentation'],
      showProgress: false,
      scope: [specFile, prodFile],
    });

    const violations = Object.values(result.analyzerResults).flatMap(
      (r: any) => r.violations || [],
    );

    const fromSpecFile = violations.filter((v: any) => v.file && v.file.includes('foo.spec.ts'));
    const fromProdFile = violations.filter((v: any) => v.file && v.file.includes('production.ts'));

    // foo.spec.ts: exempt by file path
    expect(fromSpecFile).toHaveLength(0);

    // production.ts: specialOffer should still fire
    expect(fromProdFile.length).toBeGreaterThanOrEqual(1);
    const specialOfferV = fromProdFile.find(
      (v: any) => v.message && v.message.includes('specialOffer'),
    );
    expect(specialOfferV).toBeDefined();
  });

  it('file named mock-data.ts (matching mock pattern) is exempt by path', async () => {
    const srcDir = path.join(testDir, 'src');
    await mkdir(srcDir, { recursive: true });
    const mockFile = path.join(srcDir, 'mock-data.ts');
    await writeFile(mockFile, SPECIAL_OFFER_FUNCTION, 'utf-8');

    const result = await runAudit({
      projectRoot: testDir,
      enabledAnalyzers: ['documentation'],
      showProgress: false,
      scope: [mockFile],
    });

    const violations = Object.values(result.analyzerResults).flatMap(
      (r: any) => r.violations || [],
    );

    // mock-data.ts should be exempt because file path matches 'mock' pattern
    expect(violations).toHaveLength(0);
  });
});

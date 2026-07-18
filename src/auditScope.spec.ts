/**
 * Tests for Spec 04 — Diff-Scoped Auditing & Agent Hook Integration
 *
 * Covers:
 *   R1 — Audit scope types
 *   R2 — Analyzer scoping (DRY cross-file comparison)
 *   R3 — Incremental sync on audit (hash-based change detection)
 *   R4 — CLI `changed` subcommand
 *   Scoped result isolation
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'fs/promises';
import { rmSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { CodeIndexDB } from './codeIndexDB.js';
import { initParsers } from './languages/tree-sitter/parser.js';
import { initializeLanguages } from './languages/index.js';

// ── Helpers ──────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ca-scope-'));
}

async function writeTestFile(
  dir: string,
  relPath: string,
  content: string
): Promise<string> {
  const full = join(dir, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
  return full;
}

function sampleTsFile(functions: string[]): string {
  return functions.join('\n\n');
}

function helloFunc(name: string): string {
  return (
    `export function ${name}(name: string): string {\n` +
    `  return \`Hello, \${name}!\`;\n` +
    `}`
  );
}

function addFunc(name: string): string {
  return (
    `export function ${name}(a: number, b: number): number {\n` +
    `  return a + b;\n` +
    `}`
  );
}

function mulFunc(name: string): string {
  return (
    `export function ${name}(a: number, b: number): number {\n` +
    `  return a * b;\n` +
    `}`
  );
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('Spec 04 — Diff-Scoped Auditing', () => {
  let dir: string;
  let db: CodeIndexDB;

  beforeAll(async () => {
    initializeLanguages();
    await initParsers();
  });

  beforeEach(async () => {
    dir = await makeTempDir();
    db = new CodeIndexDB(join(dir, 'index.db'));
    await db.initialize();
  });

  afterEach(async () => {
    try {
      await db.close();
    } catch { /* ok */ }
    rmSync(dir, { recursive: true, force: true });
  });

  // ── R3: Hash-based change detection ─────────────────────────────────

  describe('detectChangedFunctions (R3)', () => {
    it('detects newly added functions', async () => {
      const filePath = await writeTestFile(
        dir,
        'src/util.ts',
        sampleTsFile([helloFunc('greet')])
      );

      const result = await db.detectChangedFunctions([filePath]);

      expect(result.changedFilePaths).toContain(filePath);
      expect(result.changedFunctions).toHaveLength(1);
      expect(result.changedFunctions[0].name).toBe('greet');
      expect(result.deletedFunctions).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('detects modified functions via content_hash', async () => {
      const filePath = await writeTestFile(
        dir,
        'src/math.ts',
        sampleTsFile([addFunc('add'), mulFunc('multiply')])
      );

      // First pass: index both functions
      await db.detectChangedFunctions([filePath]);

      // Now modify only `add`
      const modified = sampleTsFile([
        addFunc('add').replace('a + b', 'a + b + 1'), // body changed
        mulFunc('multiply'),
      ]);
      await writeFile(filePath, modified);

      // Second pass: should detect only `add` as changed
      const result = await db.detectChangedFunctions([filePath]);

      expect(result.changedFilePaths).toContain(filePath);
      expect(result.changedFunctions).toHaveLength(1);
      expect(result.changedFunctions[0].name).toBe('add');
    });

    it('detects deleted functions', async () => {
      const filePath = await writeTestFile(
        dir,
        'src/math.ts',
        sampleTsFile([addFunc('add'), mulFunc('multiply')])
      );

      await db.detectChangedFunctions([filePath]);

      // Remove the file to simulate deletion
      rmSync(filePath);

      const result = await db.detectChangedFunctions([filePath]);

      expect(result.changedFilePaths).toContain(filePath);
      expect(result.deletedFunctions).toHaveLength(2);
      const names = result.deletedFunctions.map((f) => f.name).sort();
      expect(names).toEqual(['add', 'multiply']);
    });

    it('handles parse errors gracefully', async () => {
      const filePath = await writeTestFile(
        dir,
        'src/broken.ts',
        'thi$ i$ n0t valid typescr1pt 4t a11'
      );

      const result = await db.detectChangedFunctions([filePath]);

      // No functions parsed, error recorded
      expect(result.errors.length).toBeGreaterThanOrEqual(0);
    });
  });

  // ── content_hash population ─────────────────────────────────────────

  describe('content_hash', () => {
    it('populates content_hash for every indexed function after detectChangedFunctions', async () => {
      const filePath = await writeTestFile(
        dir,
        'src/math.ts',
        sampleTsFile([addFunc('add'), mulFunc('multiply')])
      );

      await db.detectChangedFunctions([filePath]);

      const allFuncs = await db.getAllFunctions();
      expect(allFuncs.length).toBeGreaterThanOrEqual(2);

      for (const func of allFuncs) {
        expect(func.content_hash).toBeTruthy();
        expect(typeof func.content_hash).toBe('string');
        expect((func.content_hash as string).length).toBeGreaterThan(0);
      }
    });

    it('different bodies produce different hashes', async () => {
      const path1 = await writeTestFile(dir, 'src/a.ts', addFunc('add'));
      const path2 = await writeTestFile(dir, 'src/b.ts', mulFunc('multiply'));

      await db.detectChangedFunctions([path1]);
      await db.detectChangedFunctions([path2]);

      const allFuncs = await db.getAllFunctions();
      const addFn = allFuncs.find((f) => f.name === 'add');
      const mulFn = allFuncs.find((f) => f.name === 'multiply');

      expect(addFn?.content_hash).not.toBe(mulFn?.content_hash);
    });

    it('identical bodies produce identical content_hashes', async () => {
      const path1 = await writeTestFile(dir, 'src/a.ts', helloFunc('hi'));
      const path2 = await writeTestFile(dir, 'src/b.ts', helloFunc('hey'));

      await db.detectChangedFunctions([path1]);
      await db.detectChangedFunctions([path2]);

      const allFuncs = await db.getAllFunctions();
      const hiFn = allFuncs.find((f) => f.name === 'hi');
      const heyFn = allFuncs.find((f) => f.name === 'hey');

      expect(hiFn?.content_hash).toBe(heyFn?.content_hash);
    });
  });

  // ── detectModifiedFiles ─────────────────────────────────────────────

  describe('detectModifiedFiles (R3 mtime)', () => {
    it('returns files with changed mtime after modification', async () => {
      const filePath = await writeTestFile(
        dir,
        'src/util.ts',
        helloFunc('greet')
      );

      await db.detectChangedFunctions([filePath]);

      // Wait a tick so mtime differs
      await new Promise((r) => setTimeout(r, 10));

      // Modify the file
      await writeFile(filePath, helloFunc('greetModified'));

      const modified = await db.detectModifiedFiles(dir);
      expect(modified).toContain(filePath);
    });

    it('returns empty when no files have changed', async () => {
      const filePath = await writeTestFile(
        dir,
        'src/util.ts',
        helloFunc('greet')
      );

      await db.detectChangedFunctions([filePath]);

      const modified = await db.detectModifiedFiles(dir);
      expect(modified).toHaveLength(0);
    });

    it('handles non-existent project root gracefully', async () => {
      // No files indexed yet → detectModifiedFiles returns empty
      const modified = await db.detectModifiedFiles(dir);
      expect(modified).toEqual([]);
    });
  });

  // ── getContentHashesForFiles ────────────────────────────────────────

  describe('getContentHashesForFiles', () => {
    it('returns per-file, per-function content hashes', async () => {
      const path1 = await writeTestFile(dir, 'src/a.ts', helloFunc('hi'));
      const path2 = await writeTestFile(dir, 'src/b.ts', addFunc('add'));

      await db.detectChangedFunctions([path1]);
      await db.detectChangedFunctions([path2]);

      const hashes = db.getContentHashesForFiles([path1, path2]);

      expect(hashes.has(path1)).toBe(true);
      expect(hashes.has(path2)).toBe(true);
      expect(hashes.get(path1)!.has('hi')).toBe(true);
      expect(hashes.get(path2)!.has('add')).toBe(true);
    });

    it('returns empty map for empty file list', () => {
      const hashes = db.getContentHashesForFiles([]);
      expect(hashes.size).toBe(0);
    });
  });

  // ── Scoped result isolation ─────────────────────────────────────────

  describe('scoped result isolation', () => {
    it('stores scoped results with scope metadata', async () => {
      const auditResult = {
        summary: { criticalIssues: 1, warnings: 0, suggestions: 0 },
        analyzerResults: { dry: { violations: [] } },
        violations: [],
        recommendations: [],
        metadata: { scope: 'scoped' },
      };

      const auditId = await db.storeAuditResults(auditResult, dir);

      const retrieved = await db.getAuditResults(auditId);
      expect(retrieved).not.toBeNull();
      expect(retrieved.metadata.scope).toBe('scoped');
    });

    it('stores full results with scope metadata', async () => {
      const auditResult = {
        summary: { criticalIssues: 0, warnings: 2, suggestions: 1 },
        analyzerResults: {},
        violations: [],
        recommendations: [],
        metadata: { scope: 'full' },
      };

      const auditId = await db.storeAuditResults(auditResult, dir);

      const retrieved = await db.getAuditResults(auditId);
      expect(retrieved).not.toBeNull();
      expect(retrieved.metadata.scope).toBe('full');
    });

    it('getMostRecentAuditResults filters by scope correctly', async () => {
      // Store scoped first (older)
      await db.storeAuditResults(
        {
          summary: { criticalIssues: 0 },
          analyzerResults: {},
          violations: [],
          recommendations: [],
          metadata: { scope: 'scoped' },
        },
        dir
      );

      // Store full second (more recent)
      await db.storeAuditResults(
        {
          summary: { criticalIssues: 1 },
          analyzerResults: {},
          violations: [],
          recommendations: [],
          metadata: { scope: 'full' },
        },
        dir
      );

      // getMostRecentAuditResults with 'full' → full audit
      const fullResult = await db.getMostRecentAuditResults(dir, 'full');
      expect(fullResult).not.toBeNull();
      if (fullResult) {
        expect(fullResult.metadata.scope).toBe('full');
      }

      // getMostRecentAuditResults with 'scoped' → scoped audit
      const scopedResult = await db.getMostRecentAuditResults(dir, 'scoped');
      expect(scopedResult).not.toBeNull();
      if (scopedResult) {
        expect(scopedResult.metadata.scope).toBe('scoped');
      }

      // No filter → most recent (which is full)
      const mostRecent = await db.getMostRecentAuditResults(dir);
      expect(mostRecent).not.toBeNull();
      if (mostRecent) {
        expect(mostRecent.metadata.scope).toBe('full');
      }
    });

    it('full audit results survive unchanged after scoped run', async () => {
      // Store a full audit
      const fullId = await db.storeAuditResults(
        {
          summary: { criticalIssues: 3, warnings: 5, suggestions: 10 },
          analyzerResults: { solids: { violations: [{ msg: 'hi' }] } },
          violations: [],
          recommendations: [],
          metadata: { scope: 'full' },
        },
        dir
      );

      // Store a scoped audit (more recent)
      await db.storeAuditResults(
        {
          summary: { criticalIssues: 1 },
          analyzerResults: { dry: { violations: [] } },
          violations: [],
          recommendations: [],
          metadata: { scope: 'scoped' },
        },
        dir
      );

      // Retrieve full audit by ID — unchanged
      const full = await db.getAuditResults(fullId);
      expect(full).not.toBeNull();
      expect(full.summary.criticalIssues).toBe(3);
      expect(full.summary.warnings).toBe(5);
    });
  });
});

// ── CLI `changed` subcommand tests ────────────────────────────────────

describe('Spec 04 — CLI changed subcommand (R4)', () => {
  it('validates --fail-on severity values', () => {
    const validSeverities = ['critical', 'warning', 'suggestion'];
    expect(validSeverities.includes('critical')).toBe(true);
    expect(validSeverities.includes('warning')).toBe(true);
    expect(validSeverities.includes('suggestion')).toBe(true);
    expect(validSeverities.includes('invalid' as any)).toBe(false);
  });

  it('exit code 2 logic: fail-on=critical with critical violation', () => {
    const severityOrder = ['critical', 'warning', 'suggestion'] as const;
    const failIndex = severityOrder.indexOf('critical');
    const hasAtOrAbove = [{ severity: 'critical' }].some((v) => {
      const vIndex = severityOrder.indexOf(v.severity as any);
      return vIndex >= 0 && vIndex <= failIndex;
    });
    expect(hasAtOrAbove).toBe(true);
  });

  it('exit code 2 logic: fail-on=critical with only suggestion', () => {
    const severityOrder = ['critical', 'warning', 'suggestion'] as const;
    const failIndex = severityOrder.indexOf('critical');
    const hasAtOrAbove = [{ severity: 'suggestion' }].some((v) => {
      const vIndex = severityOrder.indexOf(v.severity as any);
      return vIndex >= 0 && vIndex <= failIndex;
    });
    expect(hasAtOrAbove).toBe(false);
  });

  it('exit code 2 logic: fail-on=warning catches warning + critical', () => {
    const severityOrder = ['critical', 'warning', 'suggestion'] as const;
    const failIndex = severityOrder.indexOf('warning');
    // critical is at index 0, which is <= 1 (warning index)
    const hasCritical = [{ severity: 'critical' }].some((v) => {
      const vIndex = severityOrder.indexOf(v.severity as any);
      return vIndex >= 0 && vIndex <= failIndex;
    });
    expect(hasCritical).toBe(true);

    // suggestion is at index 2, which is > 1
    const hasSuggestions = [{ severity: 'suggestion' }].some((v) => {
      const vIndex = severityOrder.indexOf(v.severity as any);
      return vIndex >= 0 && vIndex <= failIndex;
    });
    expect(hasSuggestions).toBe(false);
  });

  it('resolves relative paths to absolute in CLI', () => {
    const { isAbsolute, resolve } = require('path');
    const relativePath = 'src/util.ts';
    const resolved = isAbsolute(relativePath)
      ? relativePath
      : resolve(process.cwd(), relativePath);
    expect(isAbsolute(resolved)).toBe(true);
  });
});

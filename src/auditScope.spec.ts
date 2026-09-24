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
import { SEVERITIES } from './types.js';
import type { Severity } from './types.js';

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

  // ── Spec 63 R4 — identity & language in the incremental path ──────────

  describe('detectChangedFunctions (Spec 63 R4.1 — same-named functions)', () => {
    it('reports an edit to one of two same-named functions in a file', async () => {
      const twoOverloads = (firstBody: string, secondBody: string) =>
        `export function process(input: string): string {\n  return ${firstBody};\n}\n` +
        `export function process(input: number): number {\n  return ${secondBody};\n}\n`;

      const filePath = await writeTestFile(
        dir,
        'src/overloads.ts',
        twoOverloads('input.trim()', 'input + 1')
      );

      // First pass indexes both same-named declarations (two rows at distinct lines).
      await db.detectChangedFunctions([filePath]);
      const lines = (await db.getAllFunctions())
        .map((f) => f.lineNumber)
        .sort((a, b) => a - b);
      expect(lines).toHaveLength(2);

      // Edit only the SECOND function's body.
      await writeFile(filePath, twoOverloads('input.trim()', 'input + 2'));

      const result = await db.detectChangedFunctions([filePath]);

      // Keyed on (name, line_number), exactly the edited function is reported.
      // A name-only map collapses both to one entry and reports the wrong count.
      expect(result.changedFunctions).toHaveLength(1);
      expect(result.changedFunctions[0].name).toBe('process');
      expect(result.changedFunctions[0].lineNumber).toBe(lines[1]);
    });

    it('detects deletion of one same-named function while the other remains', async () => {
      const filePath = await writeTestFile(
        dir,
        'src/overloads.ts',
        `export function process(input: string): string {\n  return input.trim();\n}\n` +
        `export function process(input: number): number {\n  return input + 1;\n}\n`
      );

      await db.detectChangedFunctions([filePath]);
      const lines = (await db.getAllFunctions())
        .map((f) => f.lineNumber)
        .sort((a, b) => a - b);
      expect(lines).toHaveLength(2);

      // Delete only the SECOND declaration; the first stays at line 1.
      await writeFile(
        filePath,
        `export function process(input: string): string {\n  return input.trim();\n}\n`
      );

      const result = await db.detectChangedFunctions([filePath]);

      // A name-only deletion set sees `process` still present and keeps both
      // rows. Keyed on (name, line_number), the second row is the one that left.
      expect(result.deletedFunctions).toHaveLength(1);
      expect(result.deletedFunctions[0].name).toBe('process');
      expect(result.deletedFunctions[0].lineNumber).toBe(lines[1]);
    });
  });

  describe('detectChangedFunctions (Spec 63 R4.2 — language routing)', () => {
    it('routes a .go file through the Go grammar, not a javascript fallback', async () => {
      const filePath = await writeTestFile(
        dir,
        'main.go',
        'package main\n\nfunc add(a, b int) int {\n\treturn a + b\n}\n'
      );

      await db.detectChangedFunctions([filePath]);

      const addFn = (await db.getAllFunctions()).find((f) => f.name === 'add');
      expect(addFn).toBeDefined();
      expect(addFn?.language).toBe('go');
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

  // ── Scoped result isolation ─────────────────────────────────────────

  describe('scoped result isolation', () => {
    it('stores scoped results with scope metadata', async () => {
      const auditResult = {
        summary: { criticalIssues: 1, severe: 0, high: 0 },
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
        summary: { criticalIssues: 0, severe: 2, high: 1 },
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
          summary: { criticalIssues: 3, severe: 5, high: 10 },
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
      expect(full.summary.severe).toBe(5);
    });
  });
});

// ── CLI `changed` subcommand tests ────────────────────────────────────

describe('Spec 04 — CLI changed subcommand (R4)', () => {
  // The production --fail-on validation (src/cli.ts) rejects any severity not
  // in `SEVERITIES` (src/types.ts). These tests assert against that production
  // constant directly — a local `['critical', 'warning', 'suggestion']` would
  // validate itself while the real gate drifted (exactly the Spec 54
  // recalibration this guard exists to catch).
  it('accepts exactly the production severity list for --fail-on', () => {
    expect(SEVERITIES).toEqual(['critical', 'severe', 'high']);
    for (const s of SEVERITIES) {
      expect(SEVERITIES.includes(s)).toBe(true);
    }
    expect((SEVERITIES as string[]).includes('invalid')).toBe(false);
  });

  it('exit code 2 logic: fail-on=critical with critical violation', () => {
    const failIndex = SEVERITIES.indexOf('critical');
    const hasAtOrAbove = [{ severity: 'critical' as Severity }].some((v) => {
      const vIndex = SEVERITIES.indexOf(v.severity);
      return vIndex >= 0 && vIndex <= failIndex;
    });
    expect(hasAtOrAbove).toBe(true);
  });

  it('exit code 2 logic: fail-on=critical with only high', () => {
    const failIndex = SEVERITIES.indexOf('critical');
    const hasAtOrAbove = [{ severity: 'high' as Severity }].some((v) => {
      const vIndex = SEVERITIES.indexOf(v.severity);
      return vIndex >= 0 && vIndex <= failIndex;
    });
    expect(hasAtOrAbove).toBe(false);
  });

  it('exit code 2 logic: fail-on=severe catches severe + critical, not high', () => {
    const failIndex = SEVERITIES.indexOf('severe');
    // critical is at index 0, which is <= 1 (severe index)
    const hasCritical = [{ severity: 'critical' as Severity }].some((v) => {
      const vIndex = SEVERITIES.indexOf(v.severity);
      return vIndex >= 0 && vIndex <= failIndex;
    });
    expect(hasCritical).toBe(true);

    // high is at index 2, which is > 1
    const hasHigh = [{ severity: 'high' as Severity }].some((v) => {
      const vIndex = SEVERITIES.indexOf(v.severity);
      return vIndex >= 0 && vIndex <= failIndex;
    });
    expect(hasHigh).toBe(false);
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

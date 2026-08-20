import { describe, it, expect } from 'vitest';
import {
  findFiles,
  discoverFilesDetailed,
  DEFAULT_EXCLUDED_FILES,
  TYPESCRIPT_EXTENSIONS,
  JAVASCRIPT_EXTENSIONS,
  ALL_EXTENSIONS,
} from './fileDiscovery.js';
import { FileAccounting } from '../services/fileAccounting.js';
import path from 'path';
import { promises as fs } from 'fs';
import os from 'os';

describe('fileDiscovery', () => {
  describe('should not exclude filesystem roots', () => {
    it('finds files when project is under /tmp', async () => {
      const tmpDir = path.join(os.tmpdir(), `ca-fd-test-${Date.now()}`);
      await fs.mkdir(tmpDir, { recursive: true });
      try {
        await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
        await fs.writeFile(path.join(tmpDir, 'src', 'hello.ts'), 'export const x = 1;');

        const files = await findFiles(tmpDir, {
          extensions: ['.ts']
        });

        expect(files.length).toBeGreaterThanOrEqual(1);
        expect(files[0]).toContain('hello.ts');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('finds files when project is under /temp', async () => {
      // Use /var/folders which contains "temp" in some OS paths — actually
      // use a temp dir via os.tmpdir() and verify it works regardless of path
      const baseDir = path.join(os.tmpdir(), `ca-fd-test-${Date.now()}`);
      await fs.mkdir(baseDir, { recursive: true });
      try {
        await fs.writeFile(path.join(baseDir, 'index.ts'), 'export const y = 2;');

        const files = await findFiles(baseDir, {
          extensions: ['.ts']
        });

        expect(files.length).toBeGreaterThanOrEqual(1);
        expect(files.some(f => f.endsWith('index.ts'))).toBe(true);
      } finally {
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    });

    it('excludes tmp dirs at any depth (transient, never source)', async () => {
      const baseDir = path.join(os.tmpdir(), `ca-fd-test-${Date.now()}`);
      await fs.mkdir(baseDir, { recursive: true });
      try {
        await fs.mkdir(path.join(baseDir, 'src', 'tmp'), { recursive: true });
        await fs.mkdir(path.join(baseDir, 'tmp'), { recursive: true });
        await fs.writeFile(path.join(baseDir, 'src', 'app.ts'), 'export const z = 3;');
        await fs.writeFile(path.join(baseDir, 'src', 'tmp', 'route.ts'), 'export const a = 4;');
        await fs.writeFile(path.join(baseDir, 'tmp', 'artifact.ts'), 'export const b = 5;');

        const files = await findFiles(baseDir, {
          extensions: ['.ts']
        });

        // tmp is any-depth (Wrangler build cache and the like), so both the
        // root tmp/ and the nested src/tmp/ are pruned; src/app.ts is the only
        // source file.
        expect(files.some(f => f.endsWith('app.ts'))).toBe(true);
        expect(files.some(f => f.endsWith(path.join('src', 'tmp', 'route.ts')))).toBe(false);
        expect(files.some(f => f.endsWith(path.join('tmp', 'artifact.ts')))).toBe(false);
      } finally {
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    });

    it('still excludes node_modules inside the project', async () => {
      const baseDir = path.join(os.tmpdir(), `ca-fd-test-${Date.now()}`);
      await fs.mkdir(baseDir, { recursive: true });
      try {
        await fs.mkdir(path.join(baseDir, 'src'), { recursive: true });
        await fs.mkdir(path.join(baseDir, 'node_modules', 'pkg'), { recursive: true });
        await fs.writeFile(path.join(baseDir, 'src', 'main.ts'), 'export const w = 5;');
        await fs.writeFile(path.join(baseDir, 'node_modules', 'pkg', 'index.ts'), 'export const v = 6;');

        const files = await findFiles(baseDir, {
          extensions: ['.ts']
        });

        expect(files.some(f => f.endsWith('main.ts'))).toBe(true);
        expect(files.some(f => f.includes('node_modules'))).toBe(false);
      } finally {
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    });
  });

  describe('Spec 43 R5 follow-up — skipped extensions', () => {
    it('records extensions discovery skipped, aggregated and sorted by count', async () => {
      const baseDir = path.join(os.tmpdir(), `ca-fd-skip-${Date.now()}`);
      await fs.mkdir(baseDir, { recursive: true });
      try {
        await fs.writeFile(path.join(baseDir, 'a.ts'), 'export const a = 1;');
        await fs.writeFile(path.join(baseDir, 'b.md'), '# b');
        await fs.writeFile(path.join(baseDir, 'c.mdx'), '# c');
        await fs.writeFile(path.join(baseDir, 'd.md'), '# d');

        const { files, skippedExtensions } = await discoverFilesDetailed(baseDir, {
          extensions: ['.ts'],
        });

        expect(files.map(f => path.basename(f))).toEqual(['a.ts']);
        // .md (count 2) before .mdx (count 1)
        expect(skippedExtensions).toEqual([
          { ext: '.md', count: 2 },
          { ext: '.mdx', count: 1 },
        ]);
      } finally {
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    });

    it('does not record extensionless files or files in excluded dirs', async () => {
      const baseDir = path.join(os.tmpdir(), `ca-fd-skip2-${Date.now()}`);
      await fs.mkdir(baseDir, { recursive: true });
      try {
        await fs.mkdir(path.join(baseDir, 'node_modules'), { recursive: true });
        await fs.writeFile(path.join(baseDir, 'main.ts'), 'export const m = 1;');
        await fs.writeFile(path.join(baseDir, 'LICENSE'), 'plain text');
        await fs.writeFile(path.join(baseDir, 'node_modules', 'pkg.md'), '# ignored');

        const { skippedExtensions } = await discoverFilesDetailed(baseDir, {
          extensions: ['.ts'],
        });

        // LICENSE has no extension → not reported. pkg.md is inside node_modules
        // (an excluded dir) → never walked → not reported.
        expect(skippedExtensions).toEqual([]);
      } finally {
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    });
  });

  describe('Bug #3 — excludes the tool\'s own output', () => {
    it('does not discover audit-report.* files by basename', async () => {
      const baseDir = path.join(os.tmpdir(), `ca-fd-report-${Date.now()}`);
      await fs.mkdir(baseDir, { recursive: true });
      try {
        await fs.writeFile(path.join(baseDir, 'app.ts'), 'export const q = 7;');
        // The report embeds raw source snippets (e.g. `error_class = 'zombie-capped'`)
        // that would otherwise be re-scanned as source on a second run.
        for (const name of DEFAULT_EXCLUDED_FILES) {
          await fs.writeFile(path.join(baseDir, name), '{"x": 1}');
        }

        const files = await findFiles(baseDir); // default ALL_EXTENSIONS

        expect(files.some(f => f.endsWith('app.ts'))).toBe(true);
        for (const name of DEFAULT_EXCLUDED_FILES) {
          expect(files.some(f => f.endsWith(name))).toBe(false);
        }
      } finally {
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    });

    it('does not discover files inside .code-index', async () => {
      const baseDir = path.join(os.tmpdir(), `ca-fd-idx-${Date.now()}`);
      await fs.mkdir(baseDir, { recursive: true });
      try {
        await fs.mkdir(path.join(baseDir, '.code-index'), { recursive: true });
        await fs.writeFile(path.join(baseDir, 'src-app.ts'), 'export const q = 8;');
        // index.db has no matching extension but the dir may hold .json/.ts artifacts
        await fs.writeFile(path.join(baseDir, '.code-index', 'index.db'), 'binary');
        await fs.writeFile(path.join(baseDir, '.code-index', 'stale.ts'), 'export const leak = 9;');

        const files = await findFiles(baseDir); // default ALL_EXTENSIONS

        expect(files.some(f => f.endsWith('src-app.ts'))).toBe(true);
        expect(files.some(f => f.includes('.code-index'))).toBe(false);
      } finally {
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    });
  });

  describe('Spec 44 — R3 missing extensions', () => {
    it('includes .mts/.cts in TypeScript and .mjs/.cjs in JavaScript extensions', () => {
      expect(TYPESCRIPT_EXTENSIONS).toEqual(expect.arrayContaining(['.mts', '.cts']));
      expect(JAVASCRIPT_EXTENSIONS).toEqual(expect.arrayContaining(['.mjs', '.cjs']));
      expect(ALL_EXTENSIONS).toEqual(
        expect.arrayContaining(['.mts', '.cts', '.mjs', '.cjs'])
      );
    });

    it('discovers .mts/.cts/.mjs/.cjs files by default', async () => {
      const baseDir = path.join(os.tmpdir(), `ca-fd-r3-${Date.now()}`);
      await fs.mkdir(baseDir, { recursive: true });
      try {
        await fs.writeFile(path.join(baseDir, 'a.mts'), 'export const a = 1;');
        await fs.writeFile(path.join(baseDir, 'b.cts'), 'export const b = 2;');
        await fs.writeFile(path.join(baseDir, 'c.mjs'), 'export const c = 3;');
        await fs.writeFile(path.join(baseDir, 'd.cjs'), 'module.exports = 4;');

        const files = await findFiles(baseDir); // default ALL_EXTENSIONS

        expect(files.some(f => f.endsWith('a.mts'))).toBe(true);
        expect(files.some(f => f.endsWith('b.cts'))).toBe(true);
        expect(files.some(f => f.endsWith('c.mjs'))).toBe(true);
        expect(files.some(f => f.endsWith('d.cjs'))).toBe(true);
      } finally {
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    });
  });

  describe('Spec 44 — directory pruned accounting', () => {
    it('records content-dir files as `directory pruned` and infra dirs as aggregate', async () => {
      const baseDir = path.join(os.tmpdir(), `ca-fd-acct-${Date.now()}`);
      await fs.mkdir(baseDir, { recursive: true });
      try {
        await fs.mkdir(path.join(baseDir, 'src'), { recursive: true });
        await fs.mkdir(path.join(baseDir, 'docs'), { recursive: true });
        await fs.mkdir(path.join(baseDir, 'node_modules', 'pkg'), { recursive: true });
        await fs.writeFile(path.join(baseDir, 'src', 'app.ts'), 'export const a = 1;');
        await fs.writeFile(path.join(baseDir, 'docs', 'guide.mdx'), '# guide');
        await fs.writeFile(path.join(baseDir, 'node_modules', 'pkg', 'index.ts'), 'export const n = 2;');

        const fa = new FileAccounting();
        const files = await findFiles(baseDir, {
          extensions: ['.ts', '.mdx'],
          fileAccounting: fa,
        });

        // Only the non-excluded file survives discovery.
        expect(files.map(f => path.basename(f))).toEqual(['app.ts']);

        const summary = fa.summary();
        // docs/guide.mdx → dropped: directory pruned (content dir), enumerated per-file.
        const dirPruned = summary.reasons['directory pruned'];
        expect(dirPruned).toBeDefined();
        expect(dirPruned!.count).toBe(1);
        expect(dirPruned!.files[0].filePath).toContain(path.join('docs', 'guide.mdx'));
        expect(dirPruned!.files[0].directory).toBe('docs');
        expect(dirPruned!.files[0].rule).toBe('DEFAULT_EXCLUDED_DIRS');

        // node_modules → aggregate infraPruned, never per-file.
        expect(summary.infraPruned).toContainEqual({
          directory: 'node_modules',
          rule: 'DEFAULT_EXCLUDED_DIRS',
          directories: 1,
        });
        expect(summary.dropped).toBe(1);
      } finally {
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    });
  });

  describe('Spec 45 R1 — root-anchored directory exclusions', () => {
    it('analyzes nested docs/ under src/ but prunes root-level docs/', async () => {
      const baseDir = path.join(os.tmpdir(), `ca-fd-r1-${Date.now()}`);
      await fs.mkdir(baseDir, { recursive: true });
      try {
        await fs.mkdir(path.join(baseDir, 'src', 'pages', 'docs'), { recursive: true });
        await fs.mkdir(path.join(baseDir, 'docs'), { recursive: true });
        await fs.writeFile(path.join(baseDir, 'src', 'pages', 'docs', 'page.ts'), 'export const p = 1;');
        await fs.writeFile(path.join(baseDir, 'docs', 'guide.mdx'), '# guide');

        const fa = new FileAccounting();
        const files = await findFiles(baseDir, {
          extensions: ['.ts', '.mdx'],
          fileAccounting: fa,
        });

        // src/pages/docs/page.ts is source; root docs/guide.mdx is pruned.
        expect(files.map(f => path.relative(baseDir, f))).toContain(
          path.join('src', 'pages', 'docs', 'page.ts')
        );
        const summary = fa.summary();
        const dirPruned = summary.reasons['directory pruned'];
        expect(dirPruned).toBeDefined();
        expect(dirPruned!.count).toBe(1);
        expect(dirPruned!.files[0].filePath).toContain(path.join('docs', 'guide.mdx'));
        expect(dirPruned!.files[0].directory).toBe('docs');
      } finally {
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    });

    it('still prunes nested node_modules at any depth (any-depth exception)', async () => {
      const baseDir = path.join(os.tmpdir(), `ca-fd-r1b-${Date.now()}`);
      await fs.mkdir(baseDir, { recursive: true });
      try {
        await fs.mkdir(path.join(baseDir, 'infra', 'node_modules', 'pkg'), { recursive: true });
        await fs.writeFile(path.join(baseDir, 'app.ts'), 'export const a = 1;');
        await fs.writeFile(path.join(baseDir, 'infra', 'node_modules', 'pkg', 'index.ts'), 'export const n = 2;');

        const fa = new FileAccounting();
        const files = await findFiles(baseDir, {
          extensions: ['.ts'],
          fileAccounting: fa,
        });

        expect(files.some(f => f.endsWith('app.ts'))).toBe(true);
        expect(files.some(f => f.includes('node_modules'))).toBe(false);
        expect(fa.summary().infraPruned).toContainEqual({
          directory: 'node_modules',
          rule: 'DEFAULT_EXCLUDED_DIRS',
          directories: 1,
        });
      } finally {
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    });

    it('prunes nested toolchain dirs (.cache, .code-index, dist) at any depth', async () => {
      const baseDir = path.join(os.tmpdir(), `ca-fd-r1c-${Date.now()}`);
      await fs.mkdir(baseDir, { recursive: true });
      try {
        await fs.mkdir(path.join(baseDir, 'scripts', '.cache', 'build-articles'), { recursive: true });
        await fs.mkdir(path.join(baseDir, 'src', 'agents', '.code-index'), { recursive: true });
        await fs.mkdir(path.join(baseDir, 'packages', 'x', 'dist'), { recursive: true });
        await fs.writeFile(path.join(baseDir, 'src', 'app.ts'), 'export const a = 1;');
        await fs.writeFile(path.join(baseDir, 'scripts', '.cache', 'build-articles', 'x.json'), '{}');
        await fs.writeFile(path.join(baseDir, 'src', 'agents', '.code-index', 'index.db'), 'binary');
        await fs.writeFile(path.join(baseDir, 'packages', 'x', 'dist', 'out.js'), 'export const o = 2;');

        const fa = new FileAccounting();
        const files = await findFiles(baseDir, { // default ALL_EXTENSIONS
          fileAccounting: fa,
        });

        // Only src/app.ts survives; the three nested toolchain dirs are pruned.
        expect(files.map(f => path.basename(f))).toEqual(['app.ts']);

        const infra = fa.summary().infraPruned;
        expect(infra).toContainEqual({ directory: '.cache', rule: 'DEFAULT_EXCLUDED_DIRS', directories: 1 });
        expect(infra).toContainEqual({ directory: '.code-index', rule: 'DEFAULT_EXCLUDED_DIRS', directories: 1 });
        expect(infra).toContainEqual({ directory: 'dist', rule: 'DEFAULT_EXCLUDED_DIRS', directories: 1 });
      } finally {
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    });
  });
});

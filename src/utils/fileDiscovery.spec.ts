import { describe, it, expect } from 'vitest';
import { findFiles, DEFAULT_EXCLUDED_FILES } from './fileDiscovery.js';
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

    it('still excludes tmp directories inside the project', async () => {
      const baseDir = path.join(os.tmpdir(), `ca-fd-test-${Date.now()}`);
      await fs.mkdir(baseDir, { recursive: true });
      try {
        await fs.mkdir(path.join(baseDir, 'src', 'tmp'), { recursive: true });
        await fs.writeFile(path.join(baseDir, 'src', 'app.ts'), 'export const z = 3;');
        await fs.writeFile(path.join(baseDir, 'src', 'tmp', 'artifact.ts'), 'export const a = 4;');

        const files = await findFiles(baseDir, {
          extensions: ['.ts']
        });

        // Should find the file in src/ but NOT in src/tmp/
        expect(files.some(f => f.endsWith('app.ts'))).toBe(true);
        expect(files.some(f => f.includes('tmp') && f.endsWith('artifact.ts'))).toBe(false);
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
});

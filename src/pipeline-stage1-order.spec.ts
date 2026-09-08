/**
 * Spec 50 — stage-1 source-before-orphan ordering invariant.
 *
 * The daemon's two-population `retryAfterMs` estimate splits the file stream at
 * the `sourceTotal` boundary and interprets every file after that boundary as an
 * orphan. That reading is only valid because stage 1 yields source files (files
 * with a LanguageAdapter) *before* orphan files. This test pins that ordering at
 * the real stage-1 generator, so a future reorder of the two loops fails loudly
 * here instead of silently corrupting the daemon's ETA.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runStage1 } from './pipeline.js';
import { initializeLanguages } from './languages/index.js';
import { initParsers } from './languages/tree-sitter/parser.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ca-stage1-order-'));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

async function yieldKinds(dir: string, explicitFiles: string[]): Promise<Array<{ kind: string; file: string }>> {
  const s1 = runStage1({ projectRoot: dir, explicitFiles });
  const out: Array<{ kind: string; file: string }> = [];
  for await (const tuple of s1.generator) {
    out.push({ kind: tuple.kind, file: tuple.file.split('/').pop()! });
  }
  return out;
}

describe('stage 1 — source files yield before orphans (Spec 50 ordering invariant)', () => {
  it('yields a parsed source file before a raw orphan, regardless of input order', async () => {
    const dir = fixture({
      'source.ts': 'export const answer: number = 42;\n',
      'orphan.json': '{ "a": 1 }\n',
    });
    // Deliberately list the orphan first — grouping must reorder it behind the source.
    const order = await yieldKinds(dir, [join(dir, 'orphan.json'), join(dir, 'source.ts')]);
    expect(order.map((t) => t.kind)).toEqual(['parsed', 'raw']);
    expect(order[0].file).toBe('source.ts');
    expect(order[1].file).toBe('orphan.json');
  });

  it('yields every source file before every orphan when the input is interleaved', async () => {
    const dir = fixture({
      'a.ts': 'const a = 1;\n',
      'b.ts': 'const b = 2;\n',
      'x.json': '{}',
      'y.json': '{}',
    });
    const order = await yieldKinds(dir, [
      join(dir, 'x.json'),
      join(dir, 'a.ts'),
      join(dir, 'y.json'),
      join(dir, 'b.ts'),
    ]);
    expect(order.map((t) => t.kind)).toEqual(['parsed', 'parsed', 'raw', 'raw']);
  });

  it('reports a source count so a caller can split the stream at the boundary', async () => {
    const dir = fixture({
      'a.ts': 'const a = 1;\n',
      'b.ts': 'const b = 2;\n',
      'x.json': '{}',
    });
    const s1 = runStage1({ projectRoot: dir, explicitFiles: [join(dir, 'a.ts'), join(dir, 'b.ts'), join(dir, 'x.json')] });
    // Consume the stream fully so the generator's eager grouping is exercised.
    const kinds: string[] = [];
    for await (const t of s1.generator) kinds.push(t.kind);
    // `fileCount` is assigned inside the generator's lazy discovery, so it is
    // available only after the stream has run.
    expect(s1.fileCount).toBe(3);
    expect(kinds).toEqual(['parsed', 'parsed', 'raw']);
  });
});

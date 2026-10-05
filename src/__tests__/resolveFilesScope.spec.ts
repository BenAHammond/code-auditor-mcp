/**
 * `resolveFilesScope` — a direct-path edit must only enter the audit scope when
 * an analyzer understands it. A `.md` / `.txt` edit is *never in scope*: it must
 * not enter `files`, because an unclaimed file makes every analyzer report
 * `filesProcessed = 0` and trips the zero-files gate as a "dark analyzer",
 * turning a prose edit into an exit-2 hook failure. The Spec 32 parse-failure
 * gate is separate and untouched — a claimed-but-unparseable file still reaches
 * the pipeline and stays loud.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFilesScope } from '../auditRunner.js';

describe('resolveFilesScope — unclaimed files never enter the audit scope', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ca-resolve-files-'));
    await writeFile(join(dir, 'README.md'), '# readme');
    await writeFile(join(dir, 'notes.txt'), 'notes');
    await writeFile(join(dir, 'app.ts'), 'const x = 1;');
    await writeFile(join(dir, 'data.json'), '{"a": 1}');
    await writeFile(join(dir, 'schema.sql'), 'SELECT 1;');
    await writeFile(join(dir, 'page.astro'), '---\n---\n<h1>hi</h1>');
    await writeFile(join(dir, 'config.yml'), 'key: value');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('drops files no analyzer understands (.md, .txt)', async () => {
    const files = await resolveFilesScope({ projectRoot: dir }, ['README.md', 'notes.txt']);
    expect(files).toEqual([]);
  });

  it('keeps files an analyzer understands (.ts)', async () => {
    const files = await resolveFilesScope({ projectRoot: dir }, ['app.ts']);
    expect(files).toEqual([join(dir, 'app.ts')]);
  });

  it('filters a mixed set down to the analyzable files', async () => {
    const files = await resolveFilesScope({ projectRoot: dir }, ['README.md', 'app.ts', 'notes.txt']);
    expect(files).toEqual([join(dir, 'app.ts')]);
  });

  it('keeps adapter-claimed (.json) and raw/markup (.sql, .astro) extensions', async () => {
    // The gate is the registry union + raw/markup, NOT the hand-maintained
    // KNOWN_SOURCE_EXTENSIONS list. A `.json` (JsonAdapter claims it) or `.sql`
    // / `.astro` (raw/markup the pipeline reads directly) must never be dropped
    // before the pipeline the way a prose edit is.
    const files = await resolveFilesScope({ projectRoot: dir }, ['data.json', 'schema.sql', 'page.astro']);
    expect(files).toEqual([
      join(dir, 'data.json'),
      join(dir, 'page.astro'),
      join(dir, 'schema.sql'),
    ]);
  });
});

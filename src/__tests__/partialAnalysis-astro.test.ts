/**
 * Spec 44 R1 follow-up — "partially analyzed" terminal state.
 *
 * A `.astro` file has no language adapter, so stage 2 drops it as `no adapter`
 * (zero stage-2 visitors). But the `styles` reducer (stage 3) reads `.astro`
 * via `styleExtractor`, independent of adapter dispatch, and can emit findings
 * from it. A file with findings is not "dropped" — it is "partially analyzed"
 * (reached by some layer, not others). This test asserts the pipeline
 * reclassifies such a file so the report never tells a user the file wasn't
 * analyzed while also showing findings from it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { runAudit } from '../auditRunner.js';

// An undefined class used in markup with a `<style>` block that defines a
// different class — the `styles/undefined-class` rule fires with `file` set to
// the `.astro` path, proving the file produced findings at stage 3.
const ASTRO_SRC = [
  '<div class="never-defined">hello</div>',
  '<style>',
  '  .foo { color: red; }',
  '</style>',
].join('\n');

describe('partially analyzed — .astro dropped by stage 2, consumed by stage 3', () => {
  let testDir: string;

  beforeAll(async () => {
    initializeLanguages();
    await initParsers();
  });

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), 'ca-partial-astro-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('reclassifies a findings-producing .astro file as `partially analyzed`, not dropped', async () => {
    await mkdir(path.join(testDir, 'src'), { recursive: true });
    await writeFile(path.join(testDir, 'src', 'page.astro'), ASTRO_SRC, 'utf-8');

    const result = await runAudit({
      projectRoot: testDir,
      enabledAnalyzers: ['styles'],
      showProgress: false,
    });

    const accounting = result.metadata?.fileAccounting;
    expect(accounting, 'fileAccounting metadata missing').toBeDefined();

    // The .astro file produced a styles finding (evidence it was reached by stage 3).
    const stylesViolations = result.analyzerResults['styles']?.violations ?? [];
    expect(stylesViolations.some((v) => v.file.endsWith('page.astro'))).toBe(true);

    // It must be counted as partially analyzed, not dropped, and still balance.
    expect(accounting!.partiallyAnalyzed).toBeGreaterThanOrEqual(1);
    expect(accounting!.analyzed + accounting!.partiallyAnalyzed + accounting!.dropped).toBe(
      accounting!.touched
    );

    // Still under its original drop reason (`no adapter`), flagged `partial: true`.
    const noAdapter = accounting!.reasons['no adapter'];
    expect(noAdapter, 'no `no adapter` reason recorded').toBeDefined();
    const astroEntry = noAdapter!.files.find((f) => f.filePath.endsWith('page.astro'));
    expect(astroEntry, 'no accounting entry for page.astro').toBeDefined();
    expect(astroEntry!.partial).toBe(true);
  });

  it('reclassifies a findings-free .astro file as `partially analyzed` (control)', async () => {
    // Class used once AND defined once → no undefined-class finding. But the
    // style indexer still READ this file (consumption, not output), so it is
    // "partially analyzed" — reached by the style layer, dropped by stage 2.
    const cleanAstro = [
      '<div class="foo">hello</div>',
      '<style>',
      '  .foo { color: red; }',
      '</style>',
    ].join('\n');
    await mkdir(path.join(testDir, 'src'), { recursive: true });
    await writeFile(path.join(testDir, 'src', 'clean.astro'), cleanAstro, 'utf-8');

    const result = await runAudit({
      projectRoot: testDir,
      enabledAnalyzers: ['styles'],
      showProgress: false,
    });

    const accounting = result.metadata?.fileAccounting;
    expect(accounting).toBeDefined();
    expect(accounting!.partiallyAnalyzed).toBe(1);
    expect(accounting!.analyzed).toBe(0);
    expect(accounting!.dropped).toBe(0);
    const entry = accounting!.reasons['no adapter']?.files.find((f) =>
      f.filePath.endsWith('clean.astro')
    );
    expect(entry).toBeDefined();
    expect(entry!.partial).toBe(true);
  });
});

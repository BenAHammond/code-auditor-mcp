/**
 * Spec 45 R5 + Spec 22 (coverage-gap reframe) — undefined-class reports, does
 * not go silent, when stylesheets were unread; and it distinguishes a typo
 * (near-miss of a defined class) from a coverage gap (no near-miss).
 *
 * Before Spec 45, a single unread stylesheet (an unsupported dialect such as
 * `.sass`/`.less`/`.styl`) made the whole `styles/undefined-class` rule report
 * `notApplicable`, and the pipeline removed its findings. That is the narrowing
 * reverted here: the class usage is still persisted (a row per file/class/line
 * in `style_class_usage`), the set-difference against defined classes still
 * runs, and the result still fires.
 *
 * The coverage-gap reframe splits the result by confidence:
 * - A near-miss of a defined class is a typo → a `styles/undefined-class`
 *   violation, carrying `details.incompleteDefinitions` (the unread-source
 *   list) so "not found" reads as "not found in any *read* stylesheet".
 * - No near-miss is "the tool didn't find a definition, not that none exists" →
 *   a `undefined-class-not-found` coverage diagnostic (off-ladder, never gates).
 *
 * This fixture proves both surfaces at once: a near-miss typo is flagged as a
 * violation AND names the unread `.sass` file, while a far-away class becomes a
 * coverage diagnostic.
 *
 * Integration suite — loads tree-sitter WASM; run with `npm run test:integration`.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { initParsers, initializeLanguages } from '../../languages/index.js';
import { runAudit } from '../../auditRunner.js';

// Two usages: `real-crad` is a near-miss of the defined `real-card` (a typo),
// `never-defined-anywhere` is far from any defined class (a coverage gap).
const TSX_SRC = [
  'export function Card() {',
  '  return (',
  '    <>',
  '      <div className="real-crad">typo</div>',
  '      <div className="never-defined-anywhere">gap</div>',
  '    </>',
  '  );',
  '}',
].join('\n');

// A real stylesheet with one declaration. The styles analyzer early-returns
// when the index has zero declarations, so a class-only fixture never reaches
// the undefined-class detector.
const CSS_SRC = '.real-card { color: red; }\n';

// A Sass indented-syntax file — a dialect the indexer cannot read, so it is
// recorded in `style_unread_sources` as "unsupported style dialect: sass".
const SASS_SRC = '.also-real-card\n  color: blue\n';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

describe('undefined-class coverage-gap reframe (Spec 45 R5 + Spec 22)', () => {
  let testDir: string;

  afterEach(async () => {
    if (testDir) await rm(testDir, { recursive: true, force: true });
  });

  it('flags the near-miss typo as a violation and the far class as a diagnostic', async () => {
    testDir = await mkdtemp(path.join(tmpdir(), 'ca-undef-context-'));
    await mkdir(path.join(testDir, 'src'), { recursive: true });
    await writeFile(path.join(testDir, 'src', 'Card.tsx'), TSX_SRC, 'utf-8');
    await writeFile(path.join(testDir, 'src', 'styles.css'), CSS_SRC, 'utf-8');
    await writeFile(path.join(testDir, 'src', 'theme.sass'), SASS_SRC, 'utf-8');

    const result = await runAudit({
      projectRoot: testDir,
      enabledAnalyzers: ['styles'],
      showProgress: false,
    });

    const stylesViolations = result.analyzerResults['styles']?.violations ?? [];
    const undef = stylesViolations.filter(
      (v) => v.rule === 'styles/undefined-class',
    );

    // 1. The near-miss typo still fires as a violation, with a rename hint.
    const typo = undef.find((v) => v.message.includes('real-crad'));
    expect(typo, 'expected a typo violation for real-crad').toBeDefined();
    expect(typo!.message).toContain('real-card');

    // 2. The typo violation carries the unread source as incomplete-definition
    //    context (Spec 45 R5) — "not found" reads as "not found in any *read*
    //    stylesheet", not "does not exist".
    const details = typo!.details as
      | { incompleteDefinitions?: string[] }
      | string
      | undefined;
    expect(details, 'expected the typo to carry details').toBeDefined();
    expect(typeof details).toBe('object');
    const ctx = (details as { incompleteDefinitions?: string[] }).incompleteDefinitions;
    expect(ctx, 'expected details.incompleteDefinitions').toBeDefined();
    expect(
      ctx!.some((s) => s.includes('theme.sass')),
      `expected incompleteDefinitions to name theme.sass, got: ${JSON.stringify(ctx)}`,
    ).toBe(true);

    // 3. The far-away class is a coverage gap — a diagnostic, never a violation.
    const farViolation = undef.find((v) =>
      v.message.includes('never-defined-anywhere'),
    );
    expect(
      farViolation,
      'expected never-defined-anywhere to NOT be a severity-ladder violation',
    ).toBeUndefined();

    const diagnostics = result.metadata?.diagnostics ?? [];
    const gap = diagnostics.find(
      (d: any) =>
        d.kind === 'undefined-class-not-found' &&
        d.message.includes('never-defined-anywhere'),
    );
    expect(gap, 'expected an undefined-class-not-found diagnostic').toBeDefined();
  });
});

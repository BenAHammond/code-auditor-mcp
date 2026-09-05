/**
 * Spec 45 R5 — undefined-class reports, does not go silent, when stylesheets
 * were unread.
 *
 * Before Spec 45, a single unread stylesheet (an unsupported dialect such as
 * `.sass`/`.less`/`.styl`) made the whole `styles/undefined-class` rule report
 * `notApplicable`, and the pipeline removed its findings. That is the narrowing
 * reverted here: the class usage is still persisted (a row per file/class/line
 * in `style_class_usage`), the set-difference against defined classes still
 * runs, and the finding still fires — carrying the unread-source list as
 * `details.incompleteDefinitions` so "undefined" reads as "not defined in any
 * *read* stylesheet".
 *
 * This fixture proves both surfaces at once: a genuinely undefined class in a
 * `.tsx` file is flagged AND the finding names the unread `.sass` file.
 *
 * Integration suite — loads tree-sitter WASM; run with `npm run test:integration`.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { initParsers, initializeLanguages } from '../../languages/index.js';
import { runAudit } from '../../auditRunner.js';

const TSX_SRC = [
  'export function Card() {',
  '  return <div className="never-defined-anywhere">hello</div>;',
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

describe('undefined-class reports with incomplete-definition context (Spec 45 R5)', () => {
  let testDir: string;

  afterEach(async () => {
    if (testDir) await rm(testDir, { recursive: true, force: true });
  });

  it('flags the undefined class AND names the unread stylesheet as context', async () => {
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

    // 1. The finding still fires — the unread stylesheet did not silence it.
    const target = undef.find((v) =>
      v.message.includes('never-defined-anywhere'),
    );
    expect(target, 'expected an undefined-class finding for never-defined-anywhere').toBeDefined();

    // 2. The finding carries the unread source as incomplete-definition context.
    const details = target!.details as
      | { incompleteDefinitions?: string[] }
      | string
      | undefined;
    expect(details, 'expected the finding to carry details').toBeDefined();
    expect(typeof details).toBe('object');
    const ctx = (details as { incompleteDefinitions?: string[] }).incompleteDefinitions;
    expect(ctx, 'expected details.incompleteDefinitions').toBeDefined();
    expect(
      ctx!.some((s) => s.includes('theme.sass')),
      `expected incompleteDefinitions to name theme.sass, got: ${JSON.stringify(ctx)}`,
    ).toBe(true);
  });
});

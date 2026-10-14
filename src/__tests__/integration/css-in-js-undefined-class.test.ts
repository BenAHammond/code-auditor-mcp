/**
 * Spec 45, Piece 3 — a class defined inside a nested CSS-in-JS block is a real
 * definition: using it in markup must NOT surface a `styles/undefined-class`
 * finding, and must NOT surface the `undefined-class-not-found` coverage
 * diagnostic (a class the tool failed to catalog, not one that doesn't exist).
 *
 * Before Piece 3, TS/JS CSS-in-JS contributed no defined classes: the
 * declaration extractor hardcoded `context: 'styled'` (no class names) and its
 * `{` filter dropped every declaration whose line carried a nested block, so a
 * class selector nested inside a `css` template never entered the catalog. A
 * markup `class="inner"` that referenced it was then "undefined".
 *
 * This fixture drives the full audit with a *near-miss* on purpose: `.innder`
 * is one edit from `.inner`, so if the nested `.inner` is not harvested the
 * undefined-class rule flags the markup use as a typo (a `styles/undefined-class`
 * violation suggesting `.innder`). Harvesting `.inner` must silence that, and
 * the far-away nested `.card` must likewise not become a coverage diagnostic.
 * A `.css` file supplies one declaration so the styles analyzer does not
 * early-return on an empty index.
 *
 * Integration suite — loads tree-sitter WASM; run with `npm run test:integration`.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { initParsers, initializeLanguages } from '../../languages/index.js';
import { runAudit } from '../../auditRunner.js';

// A CSS-in-JS template defining `.card` and, nested inside it, `.inner`.
const TSX_SRC = [
  "import { css } from 'styled-components';",
  '',
  'export const styles = css`',
  '  .card {',
  '    color: red;',
  '    .inner {',
  '      color: blue;',
  '    }',
  '  }',
  '`;',
].join('\n');

// Markup consuming both classes — the definitions live in the TSX template above.
// `.astro` is a discovered markup extension (`.html` is not discovered by the
// default audit walk), so this file's `class="…"` attributes reach the analyzer.
const HTML_SRC = [
  '<div class="card">',
  '  <span class="inner">hello</span>',
  '</div>',
].join('\n');

// One real stylesheet with a declaration. `.innder` is one edit from `.inner`:
// if the nested `.inner` is not harvested, the undefined-class rule reads the
// markup use as a typo and fires a `styles/undefined-class` violation suggesting
// `.innder`. The styles analyzer also early-returns when the index has zero
// declarations, so a class-only fixture never reaches the undefined-class
// detector.
const CSS_SRC = '.innder { color: green; }\n';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

describe('CSS-in-JS defined class resolves in markup (Spec 45 Piece 3)', () => {
  let testDir: string;

  afterEach(async () => {
    if (testDir) await rm(testDir, { recursive: true, force: true });
  });

  it('does not flag a markup use of a nested CSS-in-JS class as undefined', async () => {
    testDir = await mkdtemp(path.join(tmpdir(), 'ca-cssinjs-undef-'));
    await mkdir(path.join(testDir, 'src'), { recursive: true });
    await writeFile(path.join(testDir, 'src', 'component.tsx'), TSX_SRC, 'utf-8');
    await writeFile(path.join(testDir, 'src', 'index.astro'), HTML_SRC, 'utf-8');
    await writeFile(path.join(testDir, 'src', 'styles.css'), CSS_SRC, 'utf-8');

    const result = await runAudit({
      projectRoot: testDir,
    });

    const stylesViolations = result.analyzerResults['styles']?.violations ?? [];
    const undef = stylesViolations.filter((v) => v.rule === 'styles/undefined-class');

    // The nested `.inner` is a real definition, not a typo of `.innder` — so the
    // near-miss violation that would otherwise fire must not surface.
    const inner = undef.find((v) => v.message.includes('"inner"'));
    expect(inner, 'expected no undefined-class violation for .inner').toBeUndefined();

    // The nested parent `.card` is far from any defined class; harvested, it must
    // not surface as an undefined-class-not-found coverage diagnostic.
    const diagnostics = result.metadata?.diagnostics ?? [];
    const cardGap = diagnostics.find(
      (d: any) => d.kind === 'undefined-class-not-found' && d.message.includes('card'),
    );
    expect(cardGap, 'expected no undefined-class-not-found diagnostic for .card').toBeUndefined();
  });
});

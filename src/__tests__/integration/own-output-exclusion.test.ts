/**
 * Bug #3 — the tool must never re-scan its own output.
 *
 * A prior audit writes two artifacts that a subsequent run must ignore:
 *   1. the persisted style/code index — now `node_modules/.cache/code-auditor/index.db`,
 *      a location gitignored by universal convention so consumers never have to
 *      touch their own `.gitignore` for an internal implementation detail;
 *   2. the audit report (`audit-report.{json,html,csv,sarif}`), written into the
 *      project root, which inlines the offending source line.
 *
 * Both can embed raw source snippets — the report especially, since it inlines
 * the offending line (e.g. `error_class = 'zombie-capped'`), which the
 * class-usage regex would otherwise treat as a `class` attribute and leak back
 * into the style index as an undefined-class finding citing `audit-report.json`.
 *
 * This test runs the audit twice in the same directory and asserts that the
 * index lands under `node_modules/.cache/code-auditor` (not a project-local
 * `.code-index` dir), and that no finding from the second run cites the report
 * or the index. It also asserts the run is non-vacuous: a genuine undefined
 * class in a real `.tsx` source file must still be flagged.
 *
 * Integration suite — loads tree-sitter WASM; excluded from `npm run test`,
 * run with `npm run test:integration`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'fs/promises';
import { rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { initParsers, initializeLanguages } from '../../languages/index.js';
import { runAudit } from '../../auditRunner.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

/** A real component with a genuinely undefined class, so the run is non-vacuous. */
const TSX_SOURCE = `export function Widget() {
  return <div className="definitely-not-a-real-class-xyz">hi</div>;
}
`;

/**
 * A real stylesheet with one declaration. The styles analyzer early-returns
 * when the index has zero declarations (UniversalStylesAnalyzer.ts:1274), so a
 * class-only fixture would never exercise the undefined-class detector.
 */
const CSS_SOURCE = `.real-class { color: red; }
`;

/**
 * Simulates the tool's own report output: a JSON file whose embedded source
 * snippet contains a class attribute the class-usage regex WOULD match
 * (single-quoted, so no JSON double-quote escaping). Without the Bug #3 fix,
 * `extractClassUsage('audit-report.json', …)` extracts `zombie-capped` and the
 * undefined-class detector cites the report itself.
 */
const REPORT_SOURCE =
  `{"summary":{"totalFindings":1},"findings":[{"rule":"styles/undefined-class",` +
  `"message":"Undefined CSS class: 'zombie-capped'",` +
  `"snippet":"const el = <div className='zombie-capped'>hi</div>"}]}`;

describe('Bug #3 — own-output exclusion (run twice, no finding cites the report)', () => {
  it('stores the index under node_modules/.cache and never re-scans it or the report', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'ca-own-output-'));
    try {
      await writeFile(join(testDir, 'widget.tsx'), TSX_SOURCE, 'utf-8');
      await writeFile(join(testDir, 'styles.css'), CSS_SOURCE, 'utf-8');
      // Simulate a Node project: the nearest node_modules is the one we place here.
      await mkdir(join(testDir, 'node_modules'), { recursive: true });

      const run = () =>
        runAudit({
          projectRoot: testDir,
          enabledAnalyzers: ['styles'],
          indexFunctions: false,
          showProgress: false,
          scope: 'all',
        });

      // Run 1 — indexes into node_modules/.cache/code-auditor (gitignored).
      await run();

      // The index now lives under node_modules/.cache, never in a project-local
      // .code-index dir the consumer would have to gitignore by hand.
      expect(
        existsSync(join(testDir, 'node_modules', '.cache', 'code-auditor', 'index.db')),
        'index must live under node_modules/.cache',
      ).toBe(true);
      expect(
        existsSync(join(testDir, '.code-index')),
        'no legacy .code-index dir must be created',
      ).toBe(false);

      // The tool would now have written its report into the project root.
      await writeFile(join(testDir, 'audit-report.json'), REPORT_SOURCE, 'utf-8');

      // Run 2 — discovery must skip both the report and the index.
      const result = await run();

      const violations = result.analyzerResults['styles']?.violations ?? [];

      // Non-vacuous: the genuine undefined class is still flagged.
      const realFinding = violations.filter((v) => v.file.endsWith('widget.tsx'));
      expect(realFinding.length, 'the real undefined class must still be flagged').toBeGreaterThan(0);

      // No finding may cite the tool's own output.
      const citesOwnOutput = violations.filter(
        (v) =>
          v.file.includes('audit-report') ||
          v.file.includes('.code-index') ||
          v.file.includes(join('.cache', 'code-auditor')),
      );
      expect(citesOwnOutput, 'no finding may cite the report or index').toEqual([]);
    } finally {
      try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

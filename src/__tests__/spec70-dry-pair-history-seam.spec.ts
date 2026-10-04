/**
 * Spec 70 2b — the `persistDryPairHistory` seam stays single-purpose.
 *
 * `afterFileFacts` (the original name) was a general-purpose "do something after
 * the file facts are merged" hook, and a general-purpose hook is how
 * declared-input discipline erodes: the next consumer to need "one more thing
 * after the parse" gloms onto the same seam instead of declaring its inputs, and
 * the seam accretes into an unordered side-effect bag. The fix renamed it for
 * its one job (`persistDryPairHistory` — persist the dry-pair history to the
 * index) and documented that the `dry_pair_history` write is its ONLY legitimate
 * use.
 *
 * A name and a doc comment are not enforced by anything. This test is the
 * machine form: the seam is declared once, invoked once, and supplied by exactly
 * ONE consumer. If a second consumer wires the hook, this fails and forces the
 * question the rename was meant to make unavoidable — "is this actually the
 * dry-pair-history write, or a new input the seam should not carry?"
 *
 * The assertion is a source-shape check over the shipped `src/` tree (the test
 * directory is excluded so the assertion does not count itself):
 *   - `persistDryPairHistory` is declared (`?:`) once, in `phase/phaseModel.ts`;
 *   - it is invoked (`?.`) once, in the same file;
 *   - it is supplied (a bare `persistDryPairHistory:` property) exactly once,
 *     in `auditRunner.ts` — the one registered consumer.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url)); // src/
const SEAM = 'persistDryPairHistory';

/** Recursively collect the .ts/.tsx files under `dir`, excluding `__tests__`. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...sourceFiles(full));
    else if (extname(full) === '.ts' || extname(full) === '.tsx') out.push(full);
  }
  return out;
}

interface Site {
  file: string;
  /** Relative path from src/ for a stable, machine-readable name. */
  rel: string;
  occurrences: number;
  suppliers: number;
}

function scan(): Site[] {
  const sites: Site[] = [];
  for (const file of sourceFiles(SRC_ROOT)) {
    const text = readFileSync(file, 'utf-8');
    const occurrences = text.split(SEAM).length - 1;
    // A bare `persistDryPairHistory:` property (colon not preceded by `?`) is a
    // supplier. The `?:` declaration and the `?.` invocation both carry a `?`,
    // so they do not match.
    const suppliers = (text.match(/persistDryPairHistory\s*:/g) ?? []).length;
    if (occurrences > 0) {
      sites.push({ file, rel: relative(SRC_ROOT, file), occurrences, suppliers });
    }
  }
  return sites;
}

describe('Spec 70 2b — persistDryPairHistory has exactly one registered consumer', () => {
  it('is declared and invoked once in phaseModel.ts, and supplied once in auditRunner.ts', () => {
    const sites = scan();

    // The seam lives in exactly two files: the model that declares/invokes it,
    // and the single consumer that supplies it.
    expect(sites.map((s) => s.rel).sort()).toEqual([
      'auditRunner.ts',
      join('phase', 'phaseModel.ts'),
    ]);

    const model = sites.find((s) => s.rel === join('phase', 'phaseModel.ts'))!;
    const runner = sites.find((s) => s.rel === 'auditRunner.ts')!;

    // Declaration (`persistDryPairHistory?:`) + invocation (`persistDryPairHistory?.`).
    expect(model.occurrences).toBe(2);
    expect(model.suppliers).toBe(0);

    // The one registered consumer supplies the hook exactly once.
    expect(runner.occurrences).toBe(1);
    expect(runner.suppliers).toBe(1);
  });

  it('has no consumer outside the dry-pair-history write', () => {
    // Every supplier site (a bare `persistDryPairHistory:`) is the auditRunner
    // wiring — a second supplier anywhere else is the erosion the rename guards.
    const sites = scan();
    const supplierFiles = sites.filter((s) => s.suppliers > 0);
    expect(supplierFiles.map((s) => s.rel)).toEqual(['auditRunner.ts']);
    expect(supplierFiles.reduce((n, s) => n + s.suppliers, 0)).toBe(1);
  });
});

/**
 * Bench severity conformance guard (Spec 62 R6).
 *
 * `specs/severity-assignment-ledger.md` is the authoritative record of every
 * rule's target severity; each bench corpus `expected.json` declares the
 * severity the fixture expects a finding to carry. When the harness went dead,
 * the 78-value Spec 54 rename was applied to these fixtures as a *blanket*
 * `warning→severe` / `suggestion→high`, which does not match the ledger's
 * per-rule recalibration (e.g. `solid/method-complexity` warning→high, not
 * severe; `unknown-table` suggestion→critical, not high; `missing-org-filter`
 * → critical, not severe).
 *
 * This test makes the expected.json severity authoritative *from the ledger*:
 * every `expectedViolations[].severity` must equal the ledger's level for that
 * rule. A fixture that disagrees with the ledger is a drift, and the fix is to
 * regenerate the severity from the ledger — never to hand-edit it to match
 * whatever the analyzer happens to emit today.
 *
 * Skipped with a documented reason (never a silent pass):
 *   - `knownMisses` entries — declared misses, not expected findings.
 *   - `styles/undefined-class-disabled` — a coverage-diagnostic (off-ladder).
 *   - retired rule IDs (`single-responsibility` → `function-length`) that no
 *     longer have an emit site; they are caught by the bench drift itself.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SEVERITIES, type Severity } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..', '..');
const LEDGER_PATH = join(APP_ROOT, 'specs', 'severity-assignment-ledger.md');
const CORPUS_ROOT = join(APP_ROOT, 'bench', 'corpus');

/** Rule IDs in expected.json that have no ledger severity (retired or off-ladder). */
const SKIP_RULES = new Set([
  'single-responsibility', // retired — re-emitted as function-length
  'styles/undefined-class-disabled', // coverage diagnostic (off-ladder)
]);

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Parse the ledger's severity table into `Map<ruleId, severity>` — the same
 *  shape as `severity-ledger-conformance.test.ts`. The last row wins. */
function parseLedger(): Map<string, Severity> {
  const src = read(LEDGER_PATH);
  const out = new Map<string, Severity>();
  for (const line of src.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    const ruleMatch = (cells[1] ?? '').match(/`([^`]+)`/);
    if (!ruleMatch) continue;
    const level = (cells[3] ?? '') as Severity;
    if (!SEVERITIES.includes(level)) continue;
    out.set(ruleMatch[1], level);
  }
  return out;
}

interface ExpectedJson {
  analyzer: string;
  expectedViolations?: Array<{ file: string; rule: string; severity: string }>;
}

function collectExpected(): Array<{ corpus: string; rule: string; severity: string }> {
  const out: Array<{ corpus: string; rule: string; severity: string }> = [];
  for (const dir of readdirSync(CORPUS_ROOT)) {
    const expectedPath = join(CORPUS_ROOT, dir, 'expected.json');
    let expected: ExpectedJson;
    try {
      expected = JSON.parse(read(expectedPath));
    } catch {
      continue; // no expected.json (e.g. shadcn-jit)
    }
    // Invariant rule severities are user-defined in `.codeauditor.json`, not
    // ledger-governed — they are out of this conformance's scope.
    if (expected.analyzer === 'invariants') continue;
    for (const v of expected.expectedViolations ?? []) {
      out.push({ corpus: dir, rule: v.rule, severity: v.severity });
    }
  }
  return out;
}

describe('bench severity conformance', () => {
  const ledger = parseLedger();

  it('parses a non-trivial ledger (≥ 90 assigned rules)', () => {
    expect(ledger.size).toBeGreaterThanOrEqual(90);
  });

  it('every bench expectedViolation severity matches the ledger', () => {
    const mismatches: string[] = [];
    const unmapped: string[] = [];
    for (const { corpus, rule, severity } of collectExpected()) {
      if (SKIP_RULES.has(rule)) continue;
      const ledgerSeverity = ledger.get(rule);
      if (ledgerSeverity === undefined) {
        unmapped.push(`${corpus}: ${rule} — no ledger row`);
      } else if (severity !== ledgerSeverity) {
        mismatches.push(`${corpus}: ${rule} — fixture ${severity}, ledger ${ledgerSeverity}`);
      }
    }
    expect(unmapped, `expected.json rules with no ledger row:\n  ${unmapped.join('\n  ')}`).toEqual([]);
    expect(mismatches, `fixture↔ledger severity drift:\n  ${mismatches.join('\n  ')}`).toEqual([]);
  });
});

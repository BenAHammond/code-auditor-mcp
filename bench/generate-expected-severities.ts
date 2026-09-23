/**
 * Spec 62 R6 — regenerate each bench corpus `expected.json` severity from the
 * severity-assignment ledger.
 *
 * The ledger (`specs/severity-assignment-ledger.md`) is the authority; this
 * script rewrites every `expectedViolations[].severity` to the ledger's level
 * for that rule. It is the mechanical counterpart to
 * `src/__tests__/bench-severity-conformance.test.ts`, which asserts the two stay
 * in agreement afterward.
 *
 * Rules skipped (never rewritten): the `invariants` corpus (severities are
 * user-defined in `.codeauditor.json`), retired rule IDs
 * (`single-responsibility` → `function-length`), and the off-ladder diagnostic
 * `styles/undefined-class-disabled`.
 *
 * Run with `npx tsx bench/generate-expected-severities.ts`.
 */

import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SEVERITIES, type Severity } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..');
const LEDGER_PATH = join(APP_ROOT, 'specs', 'severity-assignment-ledger.md');
const CORPUS_ROOT = join(__dirname, 'corpus');

const SKIP_RULES = new Set(['single-responsibility', 'styles/undefined-class-disabled']);

function parseLedger(): Map<string, Severity> {
  const src = readFileSync(LEDGER_PATH, 'utf8');
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

const ledger = parseLedger();
let changed = 0;
for (const dir of readdirSync(CORPUS_ROOT)) {
  const path = join(CORPUS_ROOT, dir, 'expected.json');
  let expected: any;
  try {
    expected = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    continue;
  }
  if (expected.analyzer === 'invariants') continue;
  for (const v of expected.expectedViolations ?? []) {
    if (SKIP_RULES.has(v.rule)) continue;
    const level = ledger.get(v.rule);
    if (level === undefined || v.severity === level) continue;
    process.stderr.write(`${dir}: ${v.rule} ${v.severity} → ${level}\n`);
    v.severity = level;
    changed++;
  }
  writeFileSync(path, JSON.stringify(expected, null, 2) + '\n');
}
process.stderr.write(`\n${changed} severity value(s) regenerated from the ledger.\n`);

/**
 * Spec 49 Session 24 — `react/performance` (row 115) — memoization + missing-keys
 * honesty.
 *
 * The ledger gap: the memoization emission claimed "is missing memoization" when
 * the code only computed `complexity > 5` (a size/complexity heuristic) — the
 * message should say "consider memoizing", not assert the memoization is missing.
 * The missing-keys emission was a `!context.includes('key=')` substring over a
 * 500-char truncated context, which both missed `.map(` calls outside the window
 * and mis-attributed `key=` anywhere in the window to the wrong list.
 *
 * The predicate fix predates this sweep (spec-44, commit a60f655: "per-element
 * JSX detection against the full component body"), but that commit only added
 * tests for the inline-prop + accessibility legs. These tests pin the two
 * remaining `performance` legs — the hedged memoization message and the
 * full-source missing-keys check — end-to-end through `scanFile` + `analyzeComponent`.
 * All pass on arrival because the fix is already in; there is no pre-change
 * failure to post (same situation as `missing-field`, Session 21).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { scanFile } from '../componentScanner.js';
import type { ComponentMetadata, ComponentScanResult } from '../types.js';
import { analyzeComponent, DEFAULT_REACT_CONFIG } from './reactAnalyzer.js';
import type { ReactAnalyzerConfig } from '../types.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpDir: string;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tmpDir = await mkdtemp(join(tmpdir(), 'ca-react-perf-'));
}, 30_000);

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function analyze(
  source: string,
  config: ReactAnalyzerConfig = DEFAULT_REACT_CONFIG,
): Promise<ReturnType<typeof analyzeComponent>> {
  const filePath = join(tmpDir, `cmp-${Math.random().toString(36).slice(2)}.tsx`);
  await writeFile(filePath, source, 'utf-8');
  const result: ComponentScanResult = await scanFile(filePath);
  const component = result.components.find((c: ComponentMetadata) => c.name !== 'AnonymousComponent')!;
  expect(component, 'expected a detected component').toBeTruthy();
  return analyzeComponent(component, config, result);
}

function byRule(violations: ReturnType<typeof analyzeComponent>, rule: string) {
  return violations.filter((v) => v.rule === rule);
}

const REQUIRE_MEMO: ReactAnalyzerConfig = { ...DEFAULT_REACT_CONFIG, requireMemoization: true };

// 5 if-statements → complexity 1 + 5 = 6 > 5 (the memoization threshold).
const COMPLEX_COMPONENT = `export function Complex({ items }: { items: string[] }) {
  if (!items) return null;
  if (items.length === 0) return null;
  if (items.length === 1) return <div>{items[0]}</div>;
  if (items.length === 2) return <div>{items[0]}{items[1]}</div>;
  if (items.length === 3) return <div>{items[0]}{items[1]}{items[2]}</div>;
  return <div>{items.join(',')}</div>;
}`;

const SIMPLE_COMPONENT = `export function Simple({ name }: { name: string }) {
  return <div>{name}</div>;
}`;

describe('react performance — memoization message honesty', () => {
  it('complex component suggests memoization, does NOT claim it is missing', async () => {
    const violations = await analyze(COMPLEX_COMPONENT, REQUIRE_MEMO);
    const perf = byRule(violations, 'performance');
    expect(perf.some((v) => v.message?.includes('Consider memoizing'))).toBe(true);
    expect(perf.some((v) => v.message?.includes('is missing memoization'))).toBe(false);
  });

  it('simple component (complexity ≤ 5) is not flagged for memoization', async () => {
    const violations = await analyze(SIMPLE_COMPONENT, REQUIRE_MEMO);
    const perf = byRule(violations, 'performance');
    expect(perf.filter((v) => v.message?.includes('memoiz'))).toHaveLength(0);
  });
});

describe('react performance — missing keys in lists', () => {
  it('flags a .map() render without a key (hedged message)', async () => {
    const violations = await analyze(
      `export function List({ items }: { items: string[] }) {
  return <ul>{items.map((i) => <li>{i}</li>)}</ul>;
}`,
    );
    const perf = byRule(violations, 'performance');
    const keys = perf.filter((v) => v.message?.includes('lists without keys'));
    expect(keys.length).toBeGreaterThanOrEqual(1);
    expect(keys.every((v) => v.message?.includes('may be'))).toBe(true);
  });

  it('does NOT flag a .map() render that already has a key', async () => {
    const violations = await analyze(
      `export function List({ items }: { items: string[] }) {
  return <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>;
}`,
    );
    const perf = byRule(violations, 'performance');
    expect(perf.filter((v) => v.message?.includes('lists without keys'))).toHaveLength(0);
  });
});

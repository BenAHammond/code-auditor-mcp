/**
 * Spec-49 — `solid/class-size` message-overclaim guard (order #6).
 *
 * The authenticity ledger (row 22) marked `solid/class-size` crude with a
 * single gap: the predicate — method count + aggregate cyclomatic complexity —
 * computes real *size*, but the message claimed "splitting responsibilities",
 * which is a responsibility reading, not a size reading. A 16-method class is
 * large; it is not necessarily "doing too much".
 *
 * The emitted message was already reworded in an earlier session ("Consider
 * splitting into smaller classes."); only the registry's canonical `message`
 * template still carried the stale overclaim. The computation needed no change —
 * the ledger's own `gap` column says "computation is complete; only the
 * 'responsibilities' wording overclaims". So this is a reword, not a rewrite.
 *
 * These tests pin both sites so the overclaim cannot return under either name:
 * the emitted violation message and the registry's canonical message template.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { RULE_REGISTRY } from '../analyzers/ruleRegistry.js';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import {
  UniversalSOLIDAnalyzer,
  DEFAULT_SOLID_CONFIG,
} from '../analyzers/universal/UniversalSOLIDAnalyzer.js';

let tsAdapter: LanguageAdapter;
let solid: UniversalSOLIDAnalyzer;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not registered');
  solid = new UniversalSOLIDAnalyzer();
}, 30_000);

interface Emitted {
  rule?: string;
  message?: string;
}

async function classSizeViolations(code: string): Promise<Emitted[]> {
  const ast = parseFile('class-size-message.ts', code)!;
  if (!ast) throw new Error('failed to parse class-size snippet');
  const vs = (await (solid as any).analyzeAST(
    ast, tsAdapter, DEFAULT_SOLID_CONFIG, code,
  )) as Emitted[];
  return vs.filter((v) => v.rule === 'solid/class-size');
}

/** 16 methods — one over the 15-method threshold. */
const BIG = `class Big {
  m1() {} m2() {} m3() {} m4() {} m5() {} m6() {} m7() {} m8() {}
  m9() {} m10() {} m11() {} m12() {} m13() {} m14() {} m15() {} m16() {}
}`;

/** 15 methods — exactly at the threshold, must not fire. */
const AT_THRESHOLD = `class AtThreshold {
  m1() {} m2() {} m3() {} m4() {} m5() {} m6() {} m7() {} m8() {}
  m9() {} m10() {} m11() {} m12() {} m13() {} m14() {} m15() {}
}`;

describe('solid/class-size — size reading must not overclaim responsibility', () => {
  it('flags a 16-method class under class-size (positive)', async () => {
    const vs = await classSizeViolations(BIG);
    expect(vs.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag a 15-method class — size threshold is the only signal (near-miss)', async () => {
    const vs = await classSizeViolations(AT_THRESHOLD);
    expect(vs).toHaveLength(0);
  });

  it('frames size as size, never as responsibility — emitted and registry message (inverse near-miss)', async () => {
    // The emitted message for a large class must not resurrect the old overclaim.
    for (const v of await classSizeViolations(BIG)) {
      expect(v.message ?? '').not.toMatch(/responsibilit/i);
    }
    // The registry's canonical message template must not either.
    expect(RULE_REGISTRY['solid/class-size'].message).not.toMatch(/responsibilit/i);
  });
});

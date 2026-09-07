/**
 * Spec-49 — `solid/open-closed` message-overclaim guard (order #7 remainder,
 * row 24).
 *
 * The authenticity ledger marked `solid/open-closed` crude with a single gap: the
 * predicate — `instanceof` against a *user-defined* (non-builtin) type — computes
 * a real OCP smell (type-checking against concrete types instead of polymorphism),
 * but the message claimed "frequently modified", which is a *modification
 * frequency* reading, not a type-checking reading. Nothing in the tool measures
 * modification frequency (that needs version history), so the claim was fabricated.
 *
 * The emitted message was already reworded in an earlier session ("Class … uses
 * instanceof against a user-defined type…"); only the registry's canonical
 * `message` template still carried the stale generic overclaim ("violates the
 * Open/Closed Principle"). The predicate needed no change — the ledger's own
 * `gap` column says "instanceof detection is real". So this is a reword, not a
 * rewrite.
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

async function openClosedViolations(code: string): Promise<Emitted[]> {
  const ast = parseFile('open-closed-message.ts', code)!;
  if (!ast) throw new Error('failed to parse open-closed snippet');
  const vs = (await (solid as any).analyzeAST(
    ast, tsAdapter, DEFAULT_SOLID_CONFIG, code,
  )) as Emitted[];
  return vs.filter((v) => v.rule === 'solid/open-closed');
}

/** A class whose method type-checks `instanceof` against a user-defined type. */
const INSTANCEOF_USER_TYPE = `class Shape { area() { return 0; } }
class Circle extends Shape { area() { return 1; } }

class AreaCalculator {
  compute(shape: any) {
    if (shape instanceof Circle) { return 1; }
    return 0;
  }
}`;

/** A class whose method type-checks `instanceof` against a builtin type — a
 *  legitimate runtime concern, not an OCP extension point. */
const INSTANCEOF_BUILTIN = `class Handler {
  handle(err: any) {
    if (err instanceof Error) { throw err; }
    return null;
  }
}`;

describe('solid/open-closed — type-check reading must not overclaim modification or OCP', () => {
  it('flags instanceof against a user-defined type under open-closed (positive)', async () => {
    const vs = await openClosedViolations(INSTANCEOF_USER_TYPE);
    expect(vs.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag instanceof against a builtin type (near-miss)', async () => {
    const vs = await openClosedViolations(INSTANCEOF_BUILTIN);
    expect(vs).toHaveLength(0);
  });

  it('frames type-checking as type-checking, never as "frequently modified" or a blanket OCP violation (inverse near-miss)', async () => {
    // The emitted message must not resurrect the "frequently modified" overclaim
    // or the blanket "violates the Open/Closed Principle" framing.
    for (const v of await openClosedViolations(INSTANCEOF_USER_TYPE)) {
      expect(v.message ?? '').not.toMatch(/frequently modified/i);
      expect(v.message ?? '').not.toMatch(/violates the Open\/Closed Principle/i);
      expect(v.message ?? '').toMatch(/instanceof/i);
    }
    // The registry's canonical message template must not either.
    expect(RULE_REGISTRY['solid/open-closed'].message).not.toMatch(/violates the Open\/Closed Principle/i);
    expect(RULE_REGISTRY['solid/open-closed'].message).toMatch(/instanceof/i);
  });
});

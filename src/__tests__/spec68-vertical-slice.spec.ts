/**
 * Spec 68 §3.2 — the vertical slice: parse → `file-symbols` → SOLID rules.
 *
 * Proves the phase machinery once, end to end, for the single fact kind the
 * slice migrates first. Each case feeds a fixture through
 * `runFileSymbolsSlice` (parse → process → analyze) and asserts the rule that
 * should fire does — as a concrete `Finding`, not a boolean — and that a clean
 * file produces nothing.
 *
 * Size rules are exercised with tightened thresholds so the fixtures stay
 * short; the structural rules (open-closed, single-responsibility, Liskov,
 * dependency-inversion) use the real defaults, since they have no tunable knob.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { runFileSymbolsSlice } from '../phase/runner.js';
import type { InputFile } from '../phase/runner.js';
import type { ThresholdValues } from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function ts(source: string): InputFile {
  return { path: '/fixture/sample.ts', content: source };
}

/** Run the slice against one file and return the findings' ruleIds. */
async function ruleIds(file: InputFile, thresholds?: ThresholdValues): Promise<string[]> {
  const findings = await runFileSymbolsSlice([file], thresholds);
  return findings.map((f) => f.ruleId);
}

describe('Spec 68 §3.2 vertical slice', () => {
  it('a clean file produces no SOLID findings', async () => {
    const ids = await ruleIds(ts('export function add(a: number, b: number): number {\n  return a + b;\n}\n'));
    expect(ids).toEqual([]);
  });

  it('solid/class-size fires on a class with more than the method-count ceiling', async () => {
    const methods = Array.from({ length: 21 }, (_, i) => `  m${i}() {}`).join('\n');
    const findings = await runFileSymbolsSlice([ts(`class Big {\n${methods}\n}\n`)], { classMethodsThreshold: 20 });
    expect(findings.map((f) => f.ruleId)).toContain('solid/class-size');
    const f = findings.find((x) => x.ruleId === 'solid/class-size')!;
    expect(f.symbol).toBe('Big');
    expect(f.severity).toBe('high');
  });

  it('solid/method-complexity fires on a function past the complexity ceiling', async () => {
    const findings = await runFileSymbolsSlice(
      [ts('function branchy(x) {\n  if (x > 0) return 1;\n  return 0;\n}\n')],
      { maxMethodComplexity: 1 },
    );
    expect(findings.map((f) => f.ruleId)).toContain('solid/method-complexity');
  });

  it('solid/open-closed fires on instanceof against a user-defined type', async () => {
    const findings = await runFileSymbolsSlice([
      ts('class Area {\n  compute(shape) {\n    if (shape instanceof Circle) return 1;\n    return 0;\n  }\n}\n'),
    ]);
    expect(findings.map((f) => f.ruleId)).toContain('solid/open-closed');
  });

  it('solid/single-responsibility fires on a function spanning two concerns', async () => {
    const findings = await runFileSymbolsSlice([
      ts('function handler(req) {\n  const user = db.find(req.id);\n  sendEmail(user);\n}\n'),
    ]);
    expect(findings.map((f) => f.ruleId)).toContain('solid/single-responsibility');
  });

  it('function-length fires past the line-count ceiling', async () => {
    const findings = await runFileSymbolsSlice(
      [ts('function long(a) {\n  const b = a + 1;\n  const c = b + 1;\n  return c;\n}\n')],
      { maxLinesPerMethod: 2 },
    );
    expect(findings.map((f) => f.ruleId)).toContain('function-length');
  });

  it('parameter-count fires past the parameter ceiling', async () => {
    const findings = await runFileSymbolsSlice(
      [ts('function combine(a, b, c) {\n  return a + b + c;\n}\n')],
      { maxParametersPerMethod: 2 },
    );
    expect(findings.map((f) => f.ruleId)).toContain('parameter-count');
  });

  it('interface-size fires on a method-bearing interface past the member ceiling', async () => {
    const members = Array.from({ length: 4 }, (_, i) => `  op${i}(): void;`).join('\n');
    const findings = await runFileSymbolsSlice([ts(`interface Machine {\n${members}\n}\n`)], { maxInterfaceMembers: 2 });
    expect(findings.map((f) => f.ruleId)).toContain('interface-size');
  });

  it('solid/liskov-substitution fires when an override throws where the parent does not', async () => {
    const findings = await runFileSymbolsSlice([
      ts('class Bird {\n  fly() { return "flying"; }\n}\nclass Ostrich extends Bird {\n  fly() { throw new Error("cannot fly"); }\n}\n'),
    ]);
    expect(findings.map((f) => f.ruleId)).toContain('solid/liskov-substitution');
    const f = findings.find((x) => x.ruleId === 'solid/liskov-substitution')!;
    expect(f.severity).toBe('severe');
    expect(f.symbol).toBe('Ostrich.fly');
  });

  it('solid/dependency-inversion fires when a class holds a concrete dependency', async () => {
    const findings = await runFileSymbolsSlice([
      ts('class Service {\n  constructor() { this.repo = new PostgresRepo(); }\n}\n'),
    ]);
    expect(findings.map((f) => f.ruleId)).toContain('solid/dependency-inversion');
  });
});

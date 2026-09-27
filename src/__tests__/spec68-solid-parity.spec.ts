/**
 * Spec 68 §3.2 — parity: the migrated SOLID rules reproduce the old analyzer's
 * findings exactly.
 *
 * A rule is "migrated" only when the new `analyze(ctx)` over the `file-symbols`
 * fact produces the *same* findings the pre-migration `UniversalSOLIDAnalyzer`
 * produced on a fixture — same file, line, column, rule, severity. Not a
 * "similar count": the full multiset of identity tuples. This test runs BOTH
 * paths per rule (the old analyzer still live at the time it is written) and
 * asserts the multisets are equal and non-empty. It is the pin that lets §15
 * delete the old analyzer path without losing the golden reference — the old
 * path is deleted only after this test goes green.
 *
 * Size rules use tightened thresholds so the fixtures stay short; structural
 * rules (open-closed, single-responsibility, Liskov, dependency-inversion) use
 * their defaults (no tunable knob).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { UniversalSOLIDAnalyzer } from '../analyzers/universal/UniversalSOLIDAnalyzer.js';
import { runFileSymbolsSlice } from '../phase/runner.js';
import { solidRules } from '../phase/rules/solid.js';
import type { Violation } from '../types.js';
import type { ThresholdValues } from '../phase/types.js';

let adapter: LanguageAdapter;
let analyzer: UniversalSOLIDAnalyzer;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  adapter = LanguageRegistry.getInstance().getAdapterForFile('parity.ts')!;
  if (!adapter) throw new Error('TypeScript adapter not registered');
  analyzer = new UniversalSOLIDAnalyzer();
}, 30_000);

/** The identity tuple a parity test pins — file, line, column, severity. */
function key(f: { file: string; line?: number; column?: number; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.severity}`;
}

/** Run the old analyzer and the new slice, return the per-rule identity multisets. */
async function parity(ruleId: string, source: string, config: ThresholdValues) {
  const ast = parseFile('parity.ts', source);
  expect(ast, `fixture failed to parse`).not.toBeNull();
  const oldRaw = await (analyzer as unknown as {
    analyzeAST(ast: unknown, a: LanguageAdapter, c: unknown, s: string): Promise<Violation[]>;
  }).analyzeAST(ast, adapter, config, source);
  const old = oldRaw.filter((v) => v.rule === ruleId).map(key).sort();

  const fresh = await runFileSymbolsSlice([{ path: 'parity.ts', content: source }], config);
  const nu = fresh.filter((f) => f.ruleId === ruleId).map(key).sort();

  return { old, nu };
}

/** The TypeScript SOLID rules plus the §9 Go re-declaration, in registry order —
 *  the slice under test. `struct-size` (Go-only) is asserted present but its
 *  parity is pinned by `spec68-go-solid-parity.spec.ts`, not here. */
const RULE_IDS = solidRules.map((r) => r.id);

describe('Spec 68 SOLID parity (new analyze(ctx) === old UniversalSOLIDAnalyzer)', () => {
  it('covers exactly the ten SOLID rules in registry order', () => {
    expect(RULE_IDS).toEqual([
      'solid/class-size',
      'solid/method-complexity',
      'solid/open-closed',
      'solid/single-responsibility',
      'function-length',
      'parameter-count',
      'interface-size',
      'solid/liskov-substitution',
      'solid/dependency-inversion',
      'struct-size',
    ]);
  });

  it('solid/class-size (method count)', async () => {
    const { old, nu } = await parity(
      'solid/class-size',
      'class Widget {\n  a() {}\n  b() {}\n  c() {}\n}\n',
      { classMethodsThreshold: 2, classAggregateComplexity: 1000 },
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('solid/class-size (aggregate complexity)', async () => {
    const { old, nu } = await parity(
      'solid/class-size',
      'class Widget {\n  a(x) { if (x) return 1; return 0; }\n  b(x) { if (x) return 1; return 0; }\n}\n',
      { classMethodsThreshold: 1000, classAggregateComplexity: 2, maxMethodComplexity: 1000 },
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('solid/method-complexity (standalone function)', async () => {
    const { old, nu } = await parity(
      'solid/method-complexity',
      'function branchy(x) {\n  if (x > 0) return 1;\n  return 0;\n}\n',
      { maxMethodComplexity: 1 },
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('solid/open-closed (instanceof against a user type)', async () => {
    const { old, nu } = await parity(
      'solid/open-closed',
      'class Circle {}\nclass Area {\n  compute(shape) {\n    if (shape instanceof Circle) return 1;\n    return 0;\n  }\n}\n',
      {},
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('solid/single-responsibility (two voting concerns)', async () => {
    const { old, nu } = await parity(
      'solid/single-responsibility',
      'function handler(req) {\n  const user = db.find(req.id);\n  sendEmail(user);\n}\n',
      {},
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('function-length', async () => {
    const { old, nu } = await parity(
      'function-length',
      'function long(a) {\n  const b = a + 1;\n  const c = b + 1;\n  return c;\n}\n',
      { maxLinesPerMethod: 3 },
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('parameter-count', async () => {
    const { old, nu } = await parity(
      'parameter-count',
      'function combine(a, b, c) {\n  return a + b + c;\n}\n',
      { maxParametersPerMethod: 2 },
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('interface-size (method-bearing interface past the ceiling)', async () => {
    const { old, nu } = await parity(
      'interface-size',
      'interface Machine {\n  op0(): void;\n  op1(): void;\n  op2(): void;\n}\n',
      { maxInterfaceMembers: 2 },
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('solid/liskov-substitution (override throws, parent does not)', async () => {
    const { old, nu } = await parity(
      'solid/liskov-substitution',
      'class Bird {\n  fly() { return 1; }\n}\nclass Ostrich extends Bird {\n  fly() { throw new Error("cannot fly"); }\n}\n',
      {},
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });

  it('solid/dependency-inversion (held concrete dependency)', async () => {
    const { old, nu } = await parity(
      'solid/dependency-inversion',
      'class Service {\n  constructor() { this.repo = new PostgresRepo(); }\n}\n',
      {},
    );
    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });
});

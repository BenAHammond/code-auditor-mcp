/**
 * Spec 53 R3 — property-based generators (fast-check).
 *
 * Each construct has a *knowable-in-advance* answer (the oracle): "fires iff
 * N > threshold" or "is a write iff it carries a DML verb". The property
 * generates the construct, runs the *real* analyzer, and asserts the analyzer's
 * answer equals the oracle across the whole generated space — including every
 * wrapping context the construct can legally sit in. A mismatch is a real bug;
 * fast-check shrinks it to a minimal counterexample.
 *
 * These run the analyzer at the `analyzeAST` layer (not the full project
 * dispatch) so a `numRuns` sweep is milliseconds, not seconds-per-case. The
 * end-to-end oracles were already validated against `runAuditDispatch` in
 * `scripts/r3-oracle-probe.mjs` / `scripts/r3-wrapping-probe.mjs`; see
 * `specs/property-based-generators.md`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fc from 'fast-check';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { UniversalSOLIDAnalyzer, DEFAULT_SOLID_CONFIG } from '../analyzers/universal/UniversalSOLIDAnalyzer.js';
import {
  UniversalDataAccessAnalyzer,
  DEFAULT_DATA_ACCESS_CONFIG,
  hasWriteVerb,
} from '../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { runAuditDispatch } from '../auditRouter.js';

let adapter: LanguageAdapter;
let solid: UniversalSOLIDAnalyzer;
let dataAccess: UniversalDataAccessAnalyzer;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  adapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!adapter) throw new Error('TypeScript adapter not registered');
  solid = new UniversalSOLIDAnalyzer();
  dataAccess = new UniversalDataAccessAnalyzer();
}, 30_000);

/** Run the SOLID analyzer over `code` and return the named rule's violations. */
async function solidByRule(code: string, name: string, rule: string): Promise<any[]> {
  const ast = parseFile(`${name}.ts`, code)!;
  if (!ast) throw new Error(`parse failed for ${name}`);
  const vs = await (solid as any).analyzeAST(ast, adapter, DEFAULT_SOLID_CONFIG, code);
  return vs.filter((v: any) => v.rule === rule);
}

/** Run the data-access analyzer over `code` and return the named rule's violations. */
async function dataAccessByRule(code: string, name: string, rule: string): Promise<any[]> {
  const ast = parseFile(`${name}.ts`, code)!;
  if (!ast) throw new Error(`parse failed for ${name}`);
  const vs = await (dataAccess as any).analyzeAST(ast, adapter, DEFAULT_DATA_ACCESS_CONFIG, code);
  return vs.filter((v: any) => v.rule === rule);
}

// ---------------------------------------------------------------------------
// Wrapping matrix (W1–W9, block-level subset). `Promise.all([…])` is
// expression-only and therefore inapplicable to the declaration/statement
// constructs below (a `class`/`function` declaration or a `for` loop is not an
// array element) — see specs/property-based-generators.md §2.
// ---------------------------------------------------------------------------
const wraps: Record<string, (s: string) => string> = {
  'top-level': (s) => s,
  'named function': (s) => `function wrapper() {\n${s}\n}`,
  'arrow const': (s) => `const wrapper = () => {\n${s}\n};`,
  'class method': (s) => `class W { m() {\n${s}\n} }`,
  'IIFE': (s) => `(() => {\n${s}\n})();`,
  'try/catch': (s) => `function wrapper() { try {\n${s}\n} catch (e) {} }`,
  'if branch': (s) => `function wrapper(x) { if (x) {\n${s}\n} }`,
  'comment+reindent': (s) => s.split('\n').map((l) => '  // c\n  ' + l).join('\n'),
};

describe('R3 property — parameter-count (threshold 4)', () => {
  it('fires iff the generated function has more than 4 parameters, under every wrap', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 12 }), async (n) => {
        const params = Array.from({ length: n }, (_, i) => `p${i}`).join(', ');
        const body = `function f(${params}) { return ${n || 0}; }`;
        for (const wrap of Object.values(wraps)) {
          const vs = await solidByRule(wrap(body), 'param', 'parameter-count');
          expect(vs.length > 0).toBe(n > 4);
        }
      }),
      { numRuns: 40 },
    );
  });
});

describe('R3 property — solid/class-size (threshold 15)', () => {
  it('fires iff the generated class has more than 15 methods, under every wrap', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 24 }), async (m) => {
        const methods = Array.from({ length: m }, (_, i) => `m${i}(){return 1;}`).join(' ');
        const body = `class Big { ${methods} }`;
        for (const wrap of Object.values(wraps)) {
          const vs = await solidByRule(wrap(body), 'cls', 'solid/class-size');
          expect(vs.length > 0).toBe(m > 15);
        }
      }),
      { numRuns: 40 },
    );
  });
});

describe('R3 property — loop-query', () => {
  const loopBodies = [
    'for (let i = 0; i < 10; i++) { db.query("SELECT * FROM t WHERE id = ?", [i]); }',
    'for (const id of ids) { db.query("SELECT * FROM t WHERE id = ?", [id]); }',
    'for (const k in obj) { db.query("SELECT * FROM t WHERE k = ?", [k]); }',
    'while (cond) { db.query("SELECT * FROM t WHERE x = ?", [x]); }',
  ];

  it('a DB query inside a loop fires, under every wrap', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...loopBodies), async (body) => {
        for (const wrap of Object.values(wraps)) {
          const vs = await dataAccessByRule(wrap(body), 'loop', 'loop-query');
          expect(vs.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 40 },
    );
  });

  it('the same query outside a loop does not fire (negative control)', async () => {
    const code = 'function f(id) { return db.query("SELECT * FROM t WHERE id = ?", [id]); }';
    const vs = await dataAccessByRule(code, 'neg', 'loop-query');
    expect(vs).toHaveLength(0);
  });
});

describe('R3 property — upsert-write (write-verb classifier)', () => {
  // Each case's expected classification is independent by inspection (a DML
  // verb, or an upsert clause, is a write; a SELECT or a `REPLACE()` string
  // function is not). The classifier must be case-insensitive and respect word
  // boundaries — `INSERTX`/`XUPDATE` are not `INSERT`/`UPDATE`.
  const cases: Array<{ sql: string; write: boolean }> = [
    { sql: 'INSERT INTO t (id) VALUES (1)', write: true },
    { sql: 'DELETE FROM t WHERE id = 1', write: true },
    { sql: 'UPDATE t SET x = 1', write: true },
    { sql: 'REPLACE INTO t (id) VALUES (1)', write: true },
    { sql: 'INSERT INTO t (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 1', write: true },
    { sql: 'INSERT INTO t (id) VALUES (1) ON DUPLICATE KEY UPDATE id = 1', write: true },
    { sql: 'SELECT * FROM t', write: false },
    { sql: 'SELECT id FROM t WHERE id = 1', write: false },
    { sql: 'REPLACE(name, "a", "b")', write: false },
    { sql: 'INSERTX INTO t', write: false },
    { sql: 'xUPDATE t', write: false },
  ];

  it('classifies DML verbs as writes and lookalikes as reads, under case mutation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...cases),
        fc.constantFrom<'as-is' | 'upper' | 'lower'>('as-is', 'upper', 'lower'),
        async (c, tr) => {
          const sql = tr === 'upper' ? c.sql.toUpperCase() : tr === 'lower' ? c.sql.toLowerCase() : c.sql;
          expect(hasWriteVerb(sql)).toBe(c.write);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('R3 property — styles/undefined-class (two-file oracle)', () => {
  // Cross-file: the class catalog comes from a real `.css` file, the usage from
  // a `.tsx` `className` attribute. A used-but-undefined class fires; a defined
  // class does not. Run through the full dispatch (the single-file analyzer
  // path has no class catalog).
  it('flags a used-but-undefined class and not a defined one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ca-pb-uc-'));
    try {
      await writeFile(join(dir, 'styles.css'), '.card { display: flex; }');
      await writeFile(
        join(dir, 'view.tsx'),
        'export const v = () => <div className="missing" />;',
      );
      const result = await runAuditDispatch({ projectRoot: dir, writeToLedger: false } as any);
      const all = Object.values(result.analyzerResults ?? {}).flatMap(
        (r: any) => r.violations ?? [],
      );
      const undefinedClass = all.filter((v: any) => v.rule === 'styles/undefined-class');
      expect(undefinedClass.length).toBeGreaterThanOrEqual(1);

      await writeFile(join(dir, 'view.tsx'), 'export const v = () => <div className="card" />;');
      const result2 = await runAuditDispatch({ projectRoot: dir, writeToLedger: false } as any);
      const all2 = Object.values(result2.analyzerResults ?? {}).flatMap(
        (r: any) => r.violations ?? [],
      );
      expect(all2.filter((v: any) => v.rule === 'styles/undefined-class')).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

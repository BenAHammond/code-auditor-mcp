/**
 * Spec 49 Session 18 — `sql-injection` (row 71).
 *
 * The ledger gap: the message "Potential SQL injection via string interpolation
 * in {method}" overclaims in three ways — (1) the regex also fires on `+`
 * concatenation, not only interpolation; (2) the emitted message carries no
 * method name; (3) "SQL injection" asserts a taint the safety hatch never
 * establishes (it clears provably-safe literals, but never proves the remainder
 * is attacker-controlled).
 *
 * Honest resolution: the rule detects *dynamic SQL string construction* at
 * `query()`/`execute()` call sites — the injection vector, not the injection.
 * It is renamed `dynamic-sql-construction`; the message names the enclosing
 * function and says "interpolation or concatenation". Taint (is this actually
 * injection) is out of scope here and is covered taint-aware by
 * `sql-injection-risk` in the data-access analyzer.
 *
 * Three TDD tests pin this through the exported `checkSQLInjection`:
 *   - positive: `query("… " + id)` concatenation fires.
 *   - near-miss: parameterized `query("… ?", [id])` does NOT fire.
 *   - inverse near-miss: `query(\`… ${id}\`)` template interpolation fires.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../../../languages/index.js';
import { parseFile } from '../../../languages/adapterBridge.js';
import type { LanguageAdapter } from '../../../languages/types.js';
import { checkSQLInjection } from './codeAnalysis.js';
import type { Violation } from '../../../types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function run(source: string): Violation[] {
  const filePath = '/t/sql-injection-test.ts';
  const adapter: LanguageAdapter = LanguageRegistry.getInstance().getAdapterForFile(filePath)!;
  const ast = parseFile(filePath, source)!;
  return checkSQLInjection(ast, adapter, source);
}

const CONCAT_SOURCE = `
async function search(id: string) {
  return db.query("SELECT * FROM t WHERE id = " + id);
}
`;

const PARAMETERIZED_SOURCE = `
async function search(id: string) {
  return db.query("SELECT * FROM t WHERE id = ?", [id]);
}
`;

const TEMPLATE_SOURCE = `
async function search(id: string) {
  return db.query(\`SELECT * FROM t WHERE id = \${id}\`);
}
`;

describe('dynamic-sql-construction (renamed from sql-injection)', () => {
  it('positive — string concatenation in query() fires under the honest rule ID', () => {
    const violations = run(CONCAT_SOURCE);
    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('dynamic-sql-construction');
    expect(violations[0].message).toContain('concatenation');
    expect(violations[0].message).toContain('search'); // method name no longer omitted
  });

  it('near-miss — a parameterized query() does NOT fire', () => {
    expect(run(PARAMETERIZED_SOURCE).length).toBe(0);
  });

  it('inverse near-miss — template interpolation in query() fires (message says interpolation)', () => {
    const violations = run(TEMPLATE_SOURCE);
    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('dynamic-sql-construction');
    expect(violations[0].message).toContain('interpolation');
  });
});

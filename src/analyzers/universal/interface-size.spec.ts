/**
 * Spec-49 order #3 — `interface-segregation` → `interface-size`.
 *
 * The old `solid/interface-segregation` rule claimed to detect the Interface
 * Segregation Principle ("clients forced to depend on methods they do not
 * use") from a raw member count. Member count is a *size* reading, not a
 * segregation reading: a 21-member interface may be perfectly segregated, and
 * a 3-member interface may be unsegregated. The honest ISP computation
 * (client-usage sets) needs the call graph, so that reading is blocked (see the
 * ledger). What remains is the size signal under an honest name.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../../languages/index.js';
import { parseFile } from '../../languages/adapterBridge.js';
import type { LanguageAdapter } from '../../languages/types.js';
import { UniversalSOLIDAnalyzer, DEFAULT_SOLID_CONFIG } from './UniversalSOLIDAnalyzer.js';

let adapter: LanguageAdapter;
let analyzer: UniversalSOLIDAnalyzer;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  adapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!adapter) throw new Error('TypeScript adapter not registered');
  analyzer = new UniversalSOLIDAnalyzer();
}, 30_000);

async function interfaceSize(code: string): Promise<any[]> {
  const ast = parseFile('test.ts', code)!;
  if (!ast) throw new Error('failed to parse');
  const violations = await (analyzer as any).analyzeAST(ast, adapter, DEFAULT_SOLID_CONFIG, code);
  return violations.filter((v: any) => v.rule === 'interface-size');
}

describe('interface-size — honest size reading (spec-49 order #3)', () => {
  it('positive: an interface with many method members fires', async () => {
    const methods = Array.from({ length: 21 }, (_, i) => `m${i}(): void;`).join(' ');
    const code = `export interface Big { ${methods} }`;
    const vs = await interfaceSize(code);
    expect(vs).toHaveLength(1);
    expect(vs[0].message).toContain('21 members');
  });

  it('near-miss: a data-shape interface (only property signatures) does NOT fire', async () => {
    const props = Array.from({ length: 30 }, (_, i) => `p${i}?: string;`).join(' ');
    const code = `export interface Options { ${props} }`;
    const vs = await interfaceSize(code);
    expect(vs).toHaveLength(0);
  });

  it('near-miss: a small interface (few method members) does NOT fire', async () => {
    const code = `export interface Small { a(): void; b(): void; }`;
    const vs = await interfaceSize(code);
    expect(vs).toHaveLength(0);
  });
});

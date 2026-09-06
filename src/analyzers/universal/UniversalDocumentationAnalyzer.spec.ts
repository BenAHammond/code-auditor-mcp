/**
 * #135 — documentation noise reduction.
 *
 * The documentation analyzer's default posture is now "undocumented *logic*
 * is a defect": exported services, repositories, and utilities in `.ts` files.
 * It deliberately stays silent on the two buckets that produced 90% of the
 * corpus noise (hhra-org 1,044 → 159; recall-protocol 2,444 → 670):
 *
 *   1. UI component files (`.tsx`/`.jsx`) and Next.js framework entry points
 *      (page/layout/route/… files) — self-describing by name/location, and the
 *      react analyzer's concern space, not the documentation analyzer's.
 *   2. JSDoc tag completeness — a function with a doc comment that omits an
 *      exhaustive `@param`/`@returns` is documented; tag enumeration is an
 *      opt-in strict mode (`requireParamDocs` / `requireReturnDocs`), not a
 *      default defect.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages, LanguageRegistry } from '../../languages/index.js';
import { parseFile } from '../../languages/adapterBridge.js';
import type { LanguageAdapter } from '../../languages/types.js';
import { UniversalDocumentationAnalyzer, DEFAULT_DOCUMENTATION_CONFIG } from './UniversalDocumentationAnalyzer.js';
import type { Violation } from '../../types.js';

let analyzer: UniversalDocumentationAnalyzer;
let tsAdapter: LanguageAdapter;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not found');
  analyzer = new UniversalDocumentationAnalyzer();
}, 30_000);

async function run(sourceCode: string, filePath = 'lib/example.ts'): Promise<Violation[]> {
  const ast = parseFile(filePath, sourceCode)!;
  if (!ast) throw new Error('failed to parse fixture');
  return (await (analyzer as any).analyzeAST(ast, tsAdapter, DEFAULT_DOCUMENTATION_CONFIG, sourceCode)) as Violation[];
}

const of = (vs: Violation[], rule: string) => vs.filter((v) => v.rule === rule);

// Multi-line bodies clear the R1.3 minimum-size gate (docsMinLines default 5),
// so each test exercises the *exemption* logic rather than the size floor.
const SERVICE_FN = `export function calculateDateRanges(input) {
  const start = input.start;
  const end = input.end;
  const range = end - start;
  return range;
}`;

describe('#135 documentation analyzer — noise-reduced defaults', () => {
  it('flags an undocumented exported service function in a .ts file', async () => {
    const vs = await run(SERVICE_FN);
    expect(of(vs, 'function-documentation')).toHaveLength(1);
  });

  it('stays silent on an undocumented component in a .tsx file', async () => {
    const vs = await run(SERVICE_FN, 'components/Button.tsx');
    expect(of(vs, 'function-documentation')).toHaveLength(0);
  });

  it('stays silent on a Next.js route handler (framework entry point)', async () => {
    const vs = await run(SERVICE_FN, 'app/api/export/route.ts');
    expect(of(vs, 'function-documentation')).toHaveLength(0);
  });

  it('stays silent on a documented function missing exhaustive @param tags (default)', async () => {
    const vs = await run(
      `/** Builds the report. */
export function build(filters) {
  const a = filters.a;
  const b = filters.b;
  const c = a + b;
  return c;
}`,
    );
    expect(of(vs, 'function-documentation')).toHaveLength(0);
    expect(of(vs, 'parameter-documentation')).toHaveLength(0);
  });

  it('re-enables parameter-documentation via opt-in requireParamDocs', async () => {
    const source = `/** Builds the report. */
export function build(filters) {
  const a = filters.a;
  const b = filters.b;
  const c = a + b;
  return c;
}`;
    const ast = parseFile('lib/example.ts', source)!;
    const vs = await (analyzer as any).analyzeAST(
      ast, tsAdapter, { ...DEFAULT_DOCUMENTATION_CONFIG, requireParamDocs: true }, source,
    ) as Violation[];
    expect(of(vs, 'parameter-documentation')).toHaveLength(1);
  });

  it('still flags undocumented exported classes and public methods', async () => {
    const vs = await run('export class StatsRepository { getTotal() { return 1; } }');
    expect(of(vs, 'class-documentation')).toHaveLength(1);
    expect(of(vs, 'method-documentation')).toHaveLength(1);
  });
});

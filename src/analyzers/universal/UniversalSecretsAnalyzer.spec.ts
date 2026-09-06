/**
 * #134 — secrets analyzer: hardcoded credentials, API keys, tokens.
 *
 * Reference case (job-search/index.js):
 *   page.type('#password', 'vyy8AUVvish34Fq')
 *
 * A secret is a string literal in a credential position (secret-named variable/
 * field/object-key, or a call argument whose sibling is a credential selector)
 * whose value looks like a real credential, not a placeholder. Near-miss classes
 * that must stay silent: test fixtures, placeholder values, env var references.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages, LanguageRegistry } from '../../languages/index.js';
import { parseFile } from '../../languages/adapterBridge.js';
import type { LanguageAdapter } from '../../languages/types.js';
import { UniversalSecretsAnalyzer, DEFAULT_SECRETS_CONFIG } from './UniversalSecretsAnalyzer.js';
import type { Violation } from '../../types.js';

let analyzer: UniversalSecretsAnalyzer;
let tsAdapter: LanguageAdapter;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not found');
  analyzer = new UniversalSecretsAnalyzer();
}, 30_000);

async function run(sourceCode: string, filePath = 'secrets.ts'): Promise<Violation[]> {
  const ast = parseFile(filePath, sourceCode)!;
  if (!ast) throw new Error('failed to parse fixture');
  return (await (analyzer as any).analyzeAST(ast, tsAdapter, DEFAULT_SECRETS_CONFIG, sourceCode)) as Violation[];
}

const secrets = (vs: Violation[]) => vs.filter((v) => v.rule === 'hardcoded-secret');

describe('#134 secrets analyzer — hardcoded credentials', () => {
  it('flags the reference case: page.type("#password", "<secret>")', async () => {
    const vs = secrets(await run(
      "await page.type('#password', 'vyy8AUVvish34Fq');",
    ));
    expect(vs).toHaveLength(1);
    expect(vs[0].severity).toBe('critical');
    expect(vs[0].resolution?.action).toBe('remove-hardcoded-secret');
  });

  it('flags a secret-named variable with a high-entropy literal', async () => {
    const vs = secrets(await run("const password = 'hunter2Secret9';"));
    expect(vs).toHaveLength(1);
    expect(vs[0].severity).toBe('critical');
  });

  it('flags an object property named like a secret', async () => {
    const vs = secrets(await run("const cfg = { apiKey: 'sk-abc123XYZ789' };"));
    expect(vs).toHaveLength(1);
  });

  it('flags a field assignment to a secret-named member', async () => {
    const vs = secrets(await run("config.clientSecret = 'abcdEFGH1234!@';"));
    expect(vs).toHaveLength(1);
  });

  it('flags a Bearer token in an authorization header', async () => {
    const vs = secrets(await run(
      "const headers = { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.abc' };",
    ));
    expect(vs).toHaveLength(1);
  });

  // ── near-miss classes — must stay silent ──────────────────────────────

  it('stays silent on placeholder values', async () => {
    const vs = secrets(await run(
      "const apiKey = 'your-api-key';\nconst pwd = 'changeme';\nconst t = '<token>';",
    ));
    expect(vs).toHaveLength(0);
  });

  it('stays silent on env var references (not string literals)', async () => {
    const vs = secrets(await run(
      'const apiKey = process.env.API_KEY;\nconst token = import.meta.env.VITE_TOKEN;',
    ));
    expect(vs).toHaveLength(0);
  });

  it('stays silent on a short / low-entropy value', async () => {
    const vs = secrets(await run("const token = 'abcd';"));
    expect(vs).toHaveLength(0);
  });

  it('stays silent in test/fixture files (path exclusion)', async () => {
    const vs = secrets(await run(
      "const password = 'hunter2Secret9';",
      'fixtures/login.test.ts',
    ));
    expect(vs).toHaveLength(0);
  });

  it('respects the checkHardcodedSecrets=false gate', async () => {
    const ast = parseFile('secrets.ts', "const password = 'hunter2Secret9';")!;
    const vs = await (analyzer as any).analyzeAST(
      ast, tsAdapter, { ...DEFAULT_SECRETS_CONFIG, checkHardcodedSecrets: false }, "const password = 'hunter2Secret9';",
    ) as Violation[];
    expect(secrets(vs)).toHaveLength(0);
  });
});

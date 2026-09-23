/**
 * Spec 61 R6.5 — prove the three new security rules fire on the pre-fix tree at
 * every site listed in the spec, and produce zero findings at those sites after
 * the fix.
 *
 * Usage:
 *   cd app
 *   npx tsx scripts/spec61-verify-rules.mjs          # default: HEAD (pre-fix) vs working tree
 *   npx tsx scripts/spec61-verify-rules.mjs fdcd3f9  # explicit pre-fix ref
 *
 * Reads the pre-fix content of each target file with `git show <ref>:<path>` and
 * the post-fix content from disk, parses both, and runs UniversalSecurityAnalyzer
 * over each. Prints one line per (rule, file) with the pre-fix and post-fix
 * finding counts so the "fires before / zero after" pair is visible in one place.
 *
 * This is a verification harness, not part of the shipped tool; it lives under
 * scripts/ alongside spec60-verify.mjs.
 */
import { execFileSync } from 'node:child_process';
import { initializeLanguages, LanguageRegistry } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { parseFile } from '../src/languages/adapterBridge.js';
import { UniversalSecurityAnalyzer, DEFAULT_SECURITY_CONFIG } from '../src/analyzers/universal/UniversalSecurityAnalyzer.js';

const ref = process.argv[2] ?? 'HEAD';

// The R6.5 sites: rule → files that must fire pre-fix.
const SITES = [
  { rule: 'command-injection-risk', files: ['src/auditRunner.ts', 'src/churn/churnExtractor.ts', 'src/languages/RuntimeManager.ts'] },
  { rule: 'dynamic-require-of-project-path', files: ['src/config/lintConfigReader.ts', 'src/styles/tailwindConfigLoader.ts'] },
  { rule: 'unescaped-html-interpolation', files: ['src/mcp-ui-simple.ts'] },
];

initializeLanguages();
await initParsers();

const adapter = LanguageRegistry.getInstance().getAdapterForFile('x.ts');
const security = new UniversalSecurityAnalyzer();

function preFixContent(filePath) {
  // argv form — no shell interpolation, on principle (R2).
  return execFileSync('git', ['show', `${ref}:${filePath}`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function findingsFor(filePath, source) {
  const ast = parseFile(filePath, source);
  if (!ast) return [];
  const vs = await security.analyzeAST(ast, adapter, DEFAULT_SECURITY_CONFIG, source);
  ast.dispose?.();
  return vs;
}

let failures = 0;
for (const site of SITES) {
  for (const file of site.files) {
    let preSource;
    let preFindings;
    try {
      preSource = preFixContent(file);
      preFindings = await findingsFor(file, preSource);
    } catch (err) {
      console.log(`[${site.rule}] ${file}: PRE-FIX READ FAILED: ${err.message}`);
      failures++;
      continue;
    }

    const { readFileSync } = await import('node:fs');
    const postSource = readFileSync(file, 'utf-8');
    const postFindings = await findingsFor(file, postSource);

    const preCount = preFindings.filter((v) => v.rule === site.rule).length;
    const postCount = postFindings.filter((v) => v.rule === site.rule).length;
    const ok = preCount > 0 && postCount === 0;
    if (!ok) failures++;

    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${site.rule.padEnd(34)} ${file.padEnd(36)} pre=${preCount} post=${postCount}`,
    );
    for (const v of preFindings.filter((v) => v.rule === site.rule)) {
      console.log(`        pre-fix @ line ${v.line ?? '?'}: ${v.message}`);
    }
  }
}

console.log(failures === 0 ? '\nALL SITES: fire pre-fix, zero post-fix.' : `\n${failures} SITE(S) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;

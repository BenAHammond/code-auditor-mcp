/**
 * verify:languages — the multilingual-wiring guard.
 *
 * The Go handler was once built and validated against real cloned repos, then
 * dropped without an announcement across a series of individually-reasonable
 * CLI refactors: `functionScanner.ts`'s `getLanguageFromPath` no longer maps
 * `.go`, the native `analyzer-src/` binary is orphaned (zero TS references),
 * and `CrossLanguageSOLIDAnalyzer` was deleted in Spec 33 "because it appeared
 * in no run" — which now reads as removing something already orphaned, not
 * something dead. Not unbuilt: abandoned silently.
 *
 * That is the file-accounting failure one level up. A file silently dropped is
 * a hard error; a *language* silently dropped is not. `.go` files were
 * discovered, parsed, and handed to nobody — and nothing said so.
 *
 * This script is the language-level analogue of that accounting: a fixture
 * with one `.go` and one `.ts` file, each carrying the same known violation,
 * asserting BOTH produce findings and that the two share an analyzer::rule.
 * If any future refactor unwires Go (getLanguageFromPath, adapter registration,
 * or analyzer dispatch), the `.go` file emits nothing and this fails — the loss
 * becomes unshippable instead of discoverable months later.
 *
 * Usage (from app/):
 *   npm run build && npm run verify:languages
 *
 * Exit code: 0 iff both fixture files produce findings from a shared rule; 1
 * otherwise, with the failure named per the specific wiring loss.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(process.cwd(), 'dist/cli.js');
if (!existsSync(CLI)) {
  console.error('verify:languages: dist/cli.js not found — run `npm run build` first.');
  process.exit(1);
}

// Both files carry the same violation: an exported function with no doc
// comment, which must trigger `documentation::function-documentation` on each.
// Exported = capitalized in Go, `export` keyword in TypeScript.
const GO_SOURCE = `package sample

import "fmt"

func ProcessOrder(orderID string) error {
	if orderID == "" {
		return fmt.Errorf("empty order id")
	}
	return nil
}
`;

const TS_SOURCE = `export function ProcessOrder(orderID: string): Error | null {
	if (orderID === "") {
		return new Error("empty order id");
	}
	return null;
}
`;

// NOTE: the source dir name must not contain `fixture`, `mock`, `test`,
// `spec`, or `__tests__` — `documentation.exemptPatterns` (src/config/defaults.ts)
// matches those as bare substrings against the file path, so a `fixture/` dir
// would silently exempt both files and the guard would assert against nothing.
const outDir = mkdtempSync(join(tmpdir(), 'ca-verify-langs-out-'));
const fixtureDir = mkdtempSync(join(tmpdir(), 'ca-verify-langs-src-'));
writeFileSync(join(fixtureDir, 'main.go'), GO_SOURCE);
writeFileSync(join(fixtureDir, 'index.ts'), TS_SOURCE);

let report;
try {
  execFileSync('node', ['--expose-gc', CLI, 'audit', '--path', fixtureDir, '-f', 'json', '-o', outDir], {
    stdio: 'pipe',
  });
  report = JSON.parse(readFileSync(join(outDir, 'audit-report.json'), 'utf8'));
} catch (err) {
  // The audit CLI may exit non-zero on violations; that is not a script error
  // here — we only care about the report it writes.
  const reportPath = join(outDir, 'audit-report.json');
  if (!existsSync(reportPath)) {
    console.error('verify:languages: audit produced no report. Exit code:', err.status ?? err);
    rmSync(outDir, { recursive: true, force: true });
    process.exit(1);
  }
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
}

// Collect `analyzer::rule` per fixture file.
function rulesForFile(file) {
  const rules = new Set();
  for (const result of Object.values(report.analyzerResults ?? {})) {
    for (const v of result.violations ?? result.findings ?? []) {
      if ((v.file ?? '').endsWith(file)) {
        rules.add(`${v.analyzer ?? result.analyzer ?? '?'}::${v.rule ?? ''}`);
      }
    }
  }
  return rules;
}

const goRules = rulesForFile('main.go');
const tsRules = rulesForFile('index.ts');

console.log('');
console.log('verify:languages — mixed-language fixture (.go + .ts)');
console.log(`  main.go  → ${goRules.size} rule(s): ${[...goRules].sort().join(', ') || '(none)'}`);
console.log(`  index.ts → ${tsRules.size} rule(s): ${[...tsRules].sort().join(', ') || '(none)'}`);
console.log('');

rmSync(outDir, { recursive: true, force: true });

const shared = [...goRules].filter((r) => tsRules.has(r));

if (tsRules.size === 0) {
  console.log('FAIL — the .ts control file produced no findings. The audit is not emitting findings at all; fix that first.');
  process.exit(1);
}

if (goRules.size === 0) {
  console.log('FAIL — the .go file produced no findings. The Go language has been silently dropped (getLanguageFromPath, adapter registration, or analyzer dispatch).');
  process.exit(1);
}

if (shared.length === 0) {
  console.log('FAIL — .go and .ts produced findings but share no analyzer::rule. Cross-language analyzer parity has been lost even though both languages still emit something.');
  process.exit(1);
}

console.log(`PASS — both languages emit findings and share: ${shared.sort().join(', ')}`);
process.exit(0);

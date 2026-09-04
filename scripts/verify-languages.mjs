/**
 * verify:languages — the multilingual-wiring guard.
 *
 * The Go handler was once built and validated against real cloned repos, then
 * dropped without an announcement across a series of individually-reasonable
 * CLI refactors: `functionScanner.ts`'s `getLanguageFromPath` no longer mapped
 * `.go`, the native `analyzer-src/` binary is orphaned (zero TS references),
 * and `CrossLanguageSOLIDAnalyzer` was deleted in Spec 33 "because it appeared
 * in no run" — which now reads as removing something already orphaned, not
 * something dead. Not unbuilt: abandoned silently.
 *
 * That is the file-accounting failure one level up. A file silently dropped is
 * a hard error; a *language* silently dropped is not. `.go` files were
 * discovered, parsed, and handed to nobody — and nothing said so.
 *
 * This script is the language-level analogue of that accounting. It has two
 * phases, because the wiring has two call paths that used to diverge:
 *
 *   Phase A — the AUDIT path. A fixture with one `.go` and one `.ts` file, each
 *   carrying the same known violation, must BOTH produce findings from a shared
 *   analyzer::rule. Catches a language dropped from the analyzer dispatch
 *   (`createFunctionIndexVisitor` / the universal SOLID + documentation
 *   analyzers).
 *
 *   Phase B — the INDEX path. The same fixture is run through `index sync`,
 *   which uses a *different* `getLanguageFromPath` (the one that used to return
 *   `unknown` for `.go`, silently indexing Go functions with a bogus language
 *   and empty relational data). It must index the `.go` function with
 *   `language = 'go'` and the `.ts` control with `language = 'typescript'`.
 *   Catches a language dropped from the index/scan wiring specifically.
 *
 * If any future refactor unwires Go on either path, the corresponding assertion
 * fails — the loss becomes unshippable instead of discoverable months later.
 *
 * Usage (from app/):
 *   npm run build && npm run verify:languages
 *
 * Exit code: 0 iff both phases pass; 1 otherwise, with the failure named per
 * the specific wiring loss.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

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

// ── Phase A: the audit path ─────────────────────────────────────────────────
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
console.log('  [audit] main.go  →', goRules.size, 'rule(s):', [...goRules].sort().join(', ') || '(none)');
console.log('  [audit] index.ts →', tsRules.size, 'rule(s):', [...tsRules].sort().join(', ') || '(none)');

// ── Phase B: the index path ─────────────────────────────────────────────────
// `index sync` stores function rows through functionScanner.ts, which used to
// carry its own `getLanguageFromPath` returning `unknown` for `.go`. Re-run it
// against a fresh data dir and assert the indexed `language` column.
const dataDir = mkdtempSync(join(tmpdir(), 'ca-verify-langs-data-'));
let syncOk = true;
try {
  execFileSync('node', ['--expose-gc', CLI, 'index', 'sync', '--path', fixtureDir, '--json'], {
    env: { ...process.env, CODE_AUDITOR_DATA_DIR: dataDir },
    stdio: 'pipe',
  });
} catch (err) {
  syncOk = false;
  console.error('verify:languages: index sync failed. Exit code:', err.status ?? err);
}

// Replicate dataPaths.ts resolvePersistedIndexPath(projectRoot) for the
// CODE_AUDITOR_DATA_DIR-scoped layout: <dataDir>/projects/<sha256(root)[:16]>/index.db
function indexDbPath(dataDirRoot, projectRoot) {
  const hash = createHash('sha256').update(resolve(projectRoot)).digest('hex').substring(0, 16);
  return join(resolve(dataDirRoot), 'projects', hash, 'index.db');
}

function indexLanguageByFile(dbPath, file) {
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT language FROM functions WHERE file_path LIKE ? LIMIT 1").get(`%${file}`);
    return row ? row.language : undefined;
  } finally {
    db.close();
  }
}

const dbPath = indexDbPath(dataDir, fixtureDir);
const goIndexLang = syncOk ? indexLanguageByFile(dbPath, 'main.go') : null;
const tsIndexLang = syncOk ? indexLanguageByFile(dbPath, 'index.ts') : null;

console.log('  [index] main.go  →', goIndexLang === null ? 'not indexed' : goIndexLang === undefined ? 'indexed, no language' : `language=${goIndexLang}`);
console.log('  [index] index.ts →', tsIndexLang === null ? 'not indexed' : tsIndexLang === undefined ? 'indexed, no language' : `language=${tsIndexLang}`);
console.log('');

// Clean up all temp dirs before asserting.
rmSync(outDir, { recursive: true, force: true });
rmSync(dataDir, { recursive: true, force: true });

const failures = [];

// Phase A assertions.
if (tsRules.size === 0) {
  failures.push('the .ts control file produced no audit findings — the audit is not emitting findings at all; fix that first.');
}
if (goRules.size === 0) {
  failures.push('the .go file produced no audit findings — Go has been silently dropped from the analyzer dispatch.');
}
const shared = [...goRules].filter((r) => tsRules.has(r));
if (tsRules.size > 0 && goRules.size > 0 && shared.length === 0) {
  failures.push('.go and .ts produced findings but share no analyzer::rule — cross-language analyzer parity has been lost.');
}

// Phase B assertions.
if (!syncOk) {
  failures.push('index sync did not complete — the index path is broken before any language check.');
} else {
  if (tsIndexLang === undefined) {
    failures.push('the .ts control function was not indexed — the index path is not indexing anything; fix that first.');
  } else if (tsIndexLang !== 'typescript') {
    failures.push(`the .ts control function was indexed with language=${tsIndexLang}, expected typescript.`);
  }
  if (goIndexLang === undefined) {
    failures.push('the .go function was not indexed — Go has been silently dropped from the index/scan path (functionScanner getLanguageFromPath).');
  } else if (goIndexLang !== 'go') {
    failures.push(`the .go function was indexed with language=${goIndexLang}, expected go — the index path is mapping .go to the wrong language.`);
  }
}

if (failures.length > 0) {
  console.log('FAIL —');
  for (const f of failures) console.log('  • ' + f);
  process.exit(1);
}

console.log(`PASS — audit: both languages emit findings and share ${shared.sort().join(', ')}; index: .go→go, .ts→typescript.`);
process.exit(0);

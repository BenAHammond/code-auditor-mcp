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
 *   Phase A — the AUDIT path. A fixture with one `.go` and one `.ts` file must
 *   route them to *different* analyzers: the `.ts` file to the TypeScript
 *   pipeline (`documentation::function-documentation`), the `.go` file to the
 *   Go subprocess (`analyzer` in solid/imports/errors/…, and *no* `rule` field,
 *   which only the Go subprocess's `Violation` shape omits). Catches the Go file
 *   being silently fed to the TypeScript-tuned analyzers (the 762-finding gin
 *   result) instead of the Go subprocess.
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
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

const CLI = resolve(process.cwd(), 'dist/cli.js');
if (!existsSync(CLI)) {
  console.error('verify:languages: dist/cli.js not found — run `npm run build` first.');
  process.exit(1);
}

// The two files now deliberately carry *different* findings, because the two
// paths are supposed to differ:
//
//   - index.ts  → the TypeScript pipeline. An exported function with no doc
//     comment triggers `documentation::function-documentation`.
//
//   - main.go   → the Go subprocess. A dot import (`import . "fmt"`) triggers
//     the Go `imports` analyzer (`analyzer: "imports"`, category
//     `import-style`), a finding only the Go subprocess can emit. The same file
//     still declares an exported `ProcessOrder` so Phase B has a function to
//     index.
//
// The old fixture had both files carry the *same* `documentation` violation and
// asserted they shared an `analyzer::rule` — that asserted the very defect this
// restore removes (Go fed to the TypeScript-tuned documentation analyzer). The
// correct invariant is divergence: `.go` findings come from the Go subprocess
// analyzers (`solid`/`imports`/`errors`/…), never from `documentation`.
const GO_SOURCE = `package sample

import . "fmt"

func ProcessOrder(orderID string) error {
	if orderID == "" {
		return nil
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

// A `*_test.go` fixture. Under `go test` this file is compiled only by the test
// binary, never as production API, so the Go subprocess must exempt it the same
// way languages/testConventions.ts exempts `*_test.go`. It carries the same dot
// import that flags `main.go`, plus a `Test*` function — so if the exemption
// regresses, this file produces findings and the guard below fails.
const GO_TEST_SOURCE = `package sample

import . "fmt"

func TestProcessOrder(t *testing.T) {
	if ProcessOrder("") != nil {
		Println("bad")
	}
}
`;

// NOTE: the source dir name must not contain `fixture`, `mock`, `test`,
// `spec`, or `__tests__` — `documentation.exemptPatterns` (src/config/defaults.ts)
// matches those as bare substrings against the file path, so a `fixture/` dir
// would silently exempt both files and the guard would assert against nothing.
const outDir = mkdtempSync(join(tmpdir(), 'ca-verify-langs-out-'));
const fixtureDir = mkdtempSync(join(tmpdir(), 'ca-verify-langs-src-'));
writeFileSync(join(fixtureDir, 'main.go'), GO_SOURCE);
writeFileSync(join(fixtureDir, 'sample_test.go'), GO_TEST_SOURCE);
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

// Collect per-file `{ analyzer, rule }` pairs from the JSON report.
function findingsForFile(file) {
  const findings = [];
  for (const result of Object.values(report.analyzerResults ?? {})) {
    for (const v of result.violations ?? result.findings ?? []) {
      if ((v.file ?? '').endsWith(file)) {
        findings.push({
          analyzer: v.analyzer ?? result.analyzer ?? '?',
          rule: v.rule ?? '',
        });
      }
    }
  }
  return findings;
}

// The analyzers only the Go subprocess emits. `documentation` is deliberately
// NOT in this set — a `.go` finding labeled `documentation` means the file was
// fed to the TypeScript-tuned documentation analyzer, i.e. the routing regressed.
const GO_ANALYZERS = new Set(['solid', 'imports', 'errors', 'goroutines', 'channels']);

const goFindings = findingsForFile('main.go');
const tsFindings = findingsForFile('index.ts');
const goTestFindings = findingsForFile('sample_test.go');

console.log('');
console.log('verify:languages — mixed-language fixture (.go + .ts + _test.go)');
console.log('  [audit] main.go        →', goFindings.length, 'finding(s):',
  goFindings.map(f => `${f.analyzer}${f.rule ? '::' + f.rule : ''}`).join(', ') || '(none)');
console.log('  [audit] index.ts       →', tsFindings.length, 'finding(s):',
  tsFindings.map(f => `${f.analyzer}${f.rule ? '::' + f.rule : ''}`).join(', ') || '(none)');
console.log('  [audit] sample_test.go →', goTestFindings.length, 'finding(s):',
  goTestFindings.map(f => `${f.analyzer}${f.rule ? '::' + f.rule : ''}`).join(', ') || '(none — exempt)');

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
  // dataPaths.ts projectHash hashes the *realpath*, not the lexical path. On
  // macOS `/var` is a symlink to `/private/var`, so the two hash to different
  // keys — the DB is written under one and this guard would look it up under the
  // other. Mirror the realpath resolution (with the same lexical fallback for a
  // path that doesn't exist yet) so the lookup key matches the write key.
  let real = projectRoot;
  try {
    real = realpathSync(projectRoot);
  } catch {
    real = resolve(projectRoot);
  }
  const hash = createHash('sha256').update(real).digest('hex').substring(0, 16);
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
if (tsFindings.length === 0) {
  failures.push('the .ts control file produced no audit findings — the audit is not emitting findings at all; fix that first.');
} else if (!tsFindings.some(f => f.analyzer === 'documentation' && f.rule === 'function-documentation')) {
  failures.push('the .ts control file did not produce documentation::function-documentation — the TypeScript pipeline is not running its documentation analyzer.');
}

if (goFindings.length === 0) {
  failures.push('the .go file produced no audit findings — Go has been silently dropped from the analyzer dispatch (no Go subprocess output).');
} else if (!goFindings.some(f => GO_ANALYZERS.has(f.analyzer))) {
  failures.push(`the .go file produced findings but none from the Go subprocess (analyzer in ${[...GO_ANALYZERS].join('/')}) — the .go file is being analyzed by the TypeScript-tuned analyzers instead.`);
}

// The routing regression guard: if the .go file produced a documentation::*
// finding, it was fed to the TypeScript-tuned documentation analyzer, not the
// Go subprocess. This is the exact defect the restore removes.
if (goFindings.some(f => f.analyzer === 'documentation')) {
  failures.push('the .go file produced a documentation finding — Go is being routed to the TypeScript-tuned documentation analyzer instead of the Go subprocess.');
}

// The `_test.go` exemption guard: `*_test.go` files are test code, compiled only
// by `go test`, never production API. The Go subprocess must exempt them (the
// same per-language convention as languages/testConventions.ts). A finding here
// means test files are being analyzed again — the exact noise that re-dominates
// any Go corpus run.
if (goTestFindings.length !== 0) {
  failures.push('the .go _test.go file produced findings — Go test files are being analyzed instead of exempted (go.filePatterns regression).');
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

console.log('PASS — audit: .ts → documentation (TS pipeline), .go → Go subprocess, _test.go → exempt; index: .go→go, .ts→typescript.');
process.exit(0);

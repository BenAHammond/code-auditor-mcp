/**
 * Spec 68 §9 — parity: the migrated Go non-SOLID rules (`import-organization`,
 * `import-style`, `error-handling`, `concurrency`, `channel-deadlock`) reproduce
 * the Go binary's findings exactly.
 *
 * The Go binary emits, at column 0 (never set), on the `import_spec`/`func`
 * keyword's 1-based line:
 *
 *   - `import-organization` (severity `high`) — one finding per file, at the
 *     first import that breaks the stdlib(0)-third-party(1)-local(2) ordering;
 *   - `import-style` (severity `high`) — one finding per dot import (`. "x"`);
 *   - `error-handling` (severity `severe`) — a function that binds `err` from a
 *     call result and never checks/returns/passes/ignores it before the next bind;
 *   - `concurrency` (severity `severe`) — a function with a `go` statement and no
 *     synchronization signal (sync method selector or channel send/receive);
 *   - `channel-deadlock` (severity `critical`) — a function with no `go` whose
 *     unbuffered channel (`make(chan T)`) is operated on twice (send/receive).
 *
 * The phase model re-homes the extraction into the `imports` (Go arm),
 * `error-bindings`, `concurrency-primitives` and `channel-operations` producers
 * and re-declares the verdicts in `goRules.ts`. This test runs BOTH paths on one
 * fixture and asserts the identity multiset on `(file, line, column, rule,
 * severity)` is equal and non-empty.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile } from '../languages/adapterBridge.js';
import { PRODUCERS } from '../phase/producers.js';
import { goRules } from '../phase/rules/goRules.js';
import { dryRules } from '../phase/rules/dry.js';
import type {
  ParsedFile,
  ImportFact,
  ErrorBindingsFact,
  ConcurrencyPrimitivesFact,
  ChannelOperationsFact,
} from '../phase/types.js';

const execFileAsync = promisify(execFile);

const goDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'languages', 'go');
const goos = process.platform === 'win32' ? 'windows' : process.platform;
const goarch = ({ x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' } as Record<string, string>)[process.arch] ?? 'amd64';
const binaryName = `analyzer-${goos}-${goarch}${goos === 'windows' ? '.exe' : ''}`;
let binaryPath = join(goDir, binaryName);

interface GoViolation {
  file?: string;
  line?: number;
  column?: number;
  severity?: string;
  rule?: string;
}

/** Rebuild the analyzer binary from source (falls back to the committed binary). */
async function ensureBinaryFresh(): Promise<void> {
  try {
    const tmp = mkdtempSync(join(tmpdir(), 'ca-go-analyzer-'));
    const freshPath = join(tmp, binaryName);
    await execFileAsync('go', ['build', '-o', freshPath, 'main.go'], { cwd: goDir });
    binaryPath = freshPath;
  } catch {
    // No Go toolchain — fall through to the committed per-platform binary.
  }
}

function analyzeContent(path: string, content: string): Promise<GoViolation[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'], cwd: goDir });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => reject(new Error(`Failed to spawn Go analyzer: ${err}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Go analyzer exited with code ${code}: ${stderr}`));
        return;
      }
      try {
        const lines = stdout.trim().split('\n');
        const response = JSON.parse(lines[lines.length - 1]);
        if (response.error) throw new Error(`Go analyzer error: ${response.error.message}`);
        resolve((response.result.violations ?? []) as GoViolation[]);
      } catch (err) {
        reject(new Error(`Failed to parse Go analyzer response: ${err}`));
      }
    });
    child.stdin.write(
      JSON.stringify({
        method: 'analyzeContent',
        params: { file: path, content, options: { analyzers: ['imports', 'errors', 'goroutines', 'channels'] } },
        id: 1,
      }) + '\n',
    );
    child.stdin.end();
  });
}

/** The identity tuple a parity test pins — file, line, column, rule, severity. */
function key(f: { file: string; line?: number; column?: number; rule: string; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.rule}:${f.severity}`;
}

const FIXTURE_PATH = '/fixture/sample.go';
const FIXTURE = `package main

import (
	"github.com/gin-gonic/gin"
	"os"
)

import . "fmt"

func droppedError() {
	f, err := os.Open("x")
	f.Close()
}

func fireGoroutine() {
	go background()
}

func background() {}

func deadlock() {
	ch := make(chan int)
	ch <- 1
	<-ch
}
`;

const MIGRATED_IDS = ['import-organization', 'import-style', 'error-handling', 'concurrency', 'channel-deadlock'];

/** Run the migrated rules over the fixture's parsed facts. */
function phaseFindings(source: string): string[] {
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(FIXTURE_PATH);
  const ast = parseFile(FIXTURE_PATH, source)!;
  const file: ParsedFile = { file: FIXTURE_PATH, format: 'go', source, ast, adapter: adapter! };
  try {
    const imports = PRODUCERS['imports']['go'].process(file) as ImportFact[];
    const errorBindings = PRODUCERS['error-bindings']['go'].process(file) as ErrorBindingsFact[];
    const concurrency = PRODUCERS['concurrency-primitives']['go'].process(file) as ConcurrencyPrimitivesFact[];
    const channels = PRODUCERS['channel-operations']['go'].process(file) as ChannelOperationsFact[];

    const findings = [
      ...goRules.find((r) => r.id === 'import-organization')!.analyze({
        facts: { imports }, formats: ['go'], thresholds: {},
      }),
      ...goRules.find((r) => r.id === 'import-style')!.analyze({
        facts: { imports }, formats: ['go'], thresholds: {},
      }),
      ...goRules.find((r) => r.id === 'error-handling')!.analyze({
        facts: { 'error-bindings': errorBindings }, formats: ['go'], thresholds: {},
      }),
      ...goRules.find((r) => r.id === 'concurrency')!.analyze({
        facts: { 'concurrency-primitives': concurrency }, formats: ['go'], thresholds: {},
      }),
      ...goRules.find((r) => r.id === 'channel-deadlock')!.analyze({
        facts: { 'channel-operations': channels }, formats: ['go'], thresholds: {},
      }),
    ];
    return findings
      .map((f) => key({ file: f.file, line: f.line, column: f.column, rule: f.ruleId, severity: f.severity }))
      .sort();
  } finally {
    ast.dispose?.();
  }
}

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  await ensureBinaryFresh();
}, 60_000);

describe('Spec 68 §9 Go non-SOLID parity (imports + errors + goroutines + channels)', () => {
  it('reproduces the Go binary multiset exactly and non-empty', async () => {
    const go = await analyzeContent(FIXTURE_PATH, FIXTURE);
    const old = go
      .filter((v) => v.rule && MIGRATED_IDS.includes(v.rule))
      .map((v) => key({ file: v.file!, line: v.line, column: v.column, rule: v.rule!, severity: v.severity! }))
      .sort();

    const fresh = phaseFindings(FIXTURE);

    expect(fresh).toEqual(old);
    expect(old.length).toBeGreaterThan(0);
  });

  it('flags exactly one finding per rule', async () => {
    const go = await analyzeContent(FIXTURE_PATH, FIXTURE);
    const byRule: Record<string, number> = {};
    for (const v of go) {
      if (v.rule && MIGRATED_IDS.includes(v.rule)) {
        byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;
      }
    }
    expect(byRule['import-organization']).toBe(1);
    expect(byRule['import-style']).toBe(1);
    expect(byRule['error-handling']).toBe(1);
    expect(byRule['concurrency']).toBe(1);
    expect(byRule['channel-deadlock']).toBe(1);
  });

  it('import-organization and duplicate-import each ignore the other language in a mixed corpus', () => {
    // A TS file whose import order would false-positive under the Go grouping
    // (relative import before a bare specifier → group 2 then group 0), and a Go
    // file importing the same source twice (would false-positive `duplicate-import`).
    const mixed: ImportFact[] = [
      { file: '/fixture/a.ts', source: './local', line: 1, column: 1 },
      { file: '/fixture/a.ts', source: 'react', line: 2, column: 1 },
      { file: '/fixture/sample.go', source: 'github.com/gin-gonic/gin', line: 4, column: 2, alias: null },
      { file: '/fixture/sample.go', source: 'os', line: 5, column: 2, alias: null },
      { file: '/fixture/dup.go', source: 'fmt', line: 1, column: 1, alias: null },
      { file: '/fixture/dup.go', source: 'fmt', line: 2, column: 1, alias: '.' },
    ];

    const organization = goRules.find((r) => r.id === 'import-organization')!.analyze({
      facts: { imports: mixed }, formats: ['go'], thresholds: {},
    });
    expect(organization.map((f) => f.file)).toEqual(['/fixture/sample.go']);

    const style = goRules.find((r) => r.id === 'import-style')!.analyze({
      facts: { imports: mixed }, formats: ['go'], thresholds: {},
    });
    expect(style.map((f) => f.file)).toEqual(['/fixture/dup.go']);

    const duplicate = dryRules.find((r) => r.id === 'duplicate-import')!.analyze({
      facts: { imports: mixed }, formats: ['typescript', 'tsx', 'javascript'], thresholds: {},
    });
    // `dup.go`'s two `fmt` imports are Go — the TS-only rule must not flag them.
    expect(duplicate).toEqual([]);
  });
});

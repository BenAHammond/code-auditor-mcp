/**
 * Spec 68 §9 — parity: the migrated `function-size`, `liskov-substitution`
 * (Go arm) and `switch-size` rules reproduce the Go binary's findings exactly.
 *
 * The Go binary (`solid.go`) emits, on the `func`/`switch` keyword's 1-based
 * line, column 0:
 *
 *   - `function-size` (severity `high`) — complexity > 20 AND return count > 2
 *     AND parameter count > 6 (the AND-combined size signal);
 *   - `liskov-substitution` (severity `severe`) — a *method* (receiver != nil)
 *     whose body has a direct `panic()` call; test functions are skipped;
 *   - `switch-size` (severity `high`) — a `switch` or `type switch` with > 8
 *     `case`/`default` clauses (the `default` arm is a clause too).
 *
 * The phase model re-homes that extraction into the `go-functions` and
 * `go-switches` producers (tree-sitter `function_declaration` /
 * `method_declaration` and `expression_switch_statement` / `type_switch_statement`
 * nodes) and re-declares the thresholds in `solid.ts`. The subtle parity points:
 *
 *   - complexity counts `for` and `range` loops alike (both are `for_statement`
 *     in tree-sitter, `*ast.ForStmt`/`*ast.RangeStmt` in go/ast) and counts every
 *     `case`/`default` clause;
 *   - parameter count is *expanded* (`A, B, C int` is three), and the return
 *     count is the number of result entries (0 / 1 / N for a parenthesised list);
 *   - test functions (`Test`/`Benchmark`/`Example`/`Fuzz`) are excluded from both
 *     `function-size` and `liskov-substitution`.
 *
 * This test runs BOTH paths on one fixture and asserts the identity multiset on
 * `(file, line, column, rule, severity)` is equal and non-empty.
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
import { solidRules } from '../phase/rules/solid.js';
import type { ParsedFile, GoFunctionFact, GoSwitchFact } from '../phase/types.js';

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
        params: { file: path, content, options: { analyzers: ['solid'] } },
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

type Parser struct{}

// AND-combined size signal: complexity 23 (>20), 3 returns (>2), 7 params (>6).
func huge(a int, b int, c int, d int, e int, f int, g int) (int, string, bool) {
	x := 0
	if b > 1 { x++ }
	if c > 2 { x++ }
	if d > 3 { x++ }
	if e > 4 { x++ }
	if f > 5 { x++ }
	if g > 6 { x++ }
	if a > 7 { x++ }
	if b > 8 { x++ }
	if c > 9 { x++ }
	if d > 10 { x++ }
	if e > 11 { x++ }
	if f > 12 { x++ }
	if g > 13 { x++ }
	if a > 14 { x++ }
	if b > 15 { x++ }
	if c > 16 { x++ }
	if d > 17 { x++ }
	if e > 18 { x++ }
	if f > 19 { x++ }
	if g > 20 { x++ }
	for i := 0; i < 1; i++ { x++ }
	for _, v := range []int{1} { _ = v }
	return x, "ok", true
}

// Large in two dimensions but complexity 1 — the AND guard suppresses it.
func largeButSimple(a, b, c, d, e, f, g, h int) (int, string, bool) {
	return 0, "", true
}

func (p *Parser) parse() {
	panic("unexpected token")
}

func (p *Parser) recover() error {
	return nil
}

func freePanic() {
	panic("free function")
}

func (p *Parser) TestRecover() {
	panic("test panic")
}

// 10 case clauses, no default — over the 8-clause threshold.
func manyCases(x int) int {
	switch x {
	case 0: return 0
	case 1: return 1
	case 2: return 2
	case 3: return 3
	case 4: return 4
	case 5: return 5
	case 6: return 6
	case 7: return 7
	case 8: return 8
	case 9: return 9
	}
	return -1
}

// 9 type cases — over the 8-clause threshold.
func manyTypeCases(v interface{}) int {
	switch v.(type) {
	case int: return 1
	case string: return 2
	case bool: return 3
	case float64: return 4
	case []int: return 5
	case map[string]int: return 6
	case chan int: return 7
	case func(): return 8
	case struct{}: return 9
	}
	return 0
}

// 8 case clauses + 1 default = 9 — the default arm is a clause too.
func withDefault(x int) int {
	switch x {
	case 0: return 0
	case 1: return 1
	case 2: return 2
	case 3: return 3
	case 4: return 4
	case 5: return 5
	case 6: return 6
	case 7: return 7
	default: return -1
	}
}

func fewCases(x int) int {
	switch x {
	case 0: return 0
	case 1: return 1
	case 2: return 2
	case 3: return 3
	}
	return -1
}
`;

const MIGRATED_IDS = ['function-size', 'liskov-substitution', 'switch-size'];

/** Run the migrated rules over the fixture's parsed `go-functions` + `go-switches` facts. */
function phaseFindings(source: string): string[] {
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(FIXTURE_PATH);
  const ast = parseFile(FIXTURE_PATH, source)!;
  const file: ParsedFile = { file: FIXTURE_PATH, format: 'go', source, ast, adapter: adapter! };
  try {
    const funcs = PRODUCERS['go-functions']['go'].process(file) as GoFunctionFact[];
    const switches = PRODUCERS['go-switches']['go'].process(file) as GoSwitchFact[];
    const functionSize = solidRules.find((r) => r.id === 'function-size')!;
    const liskov = solidRules.find((r) => r.id === 'liskov-substitution')!;
    const switchSize = solidRules.find((r) => r.id === 'switch-size')!;
    const findings = [
      ...(functionSize.analyze({
        facts: { 'go-functions': funcs },
        formats: ['go'],
        thresholds: {},
      }) as ReturnType<typeof functionSize.analyze>),
      ...(liskov.analyze({
        facts: { 'go-functions': funcs },
        formats: ['go'],
        thresholds: {},
      }) as ReturnType<typeof liskov.analyze>),
      ...(switchSize.analyze({
        facts: { 'go-switches': switches },
        formats: ['go'],
        thresholds: {},
      }) as ReturnType<typeof switchSize.analyze>),
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

describe('Spec 68 §9 Go SOLID parity (function-size + liskov-substitution + switch-size)', () => {
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

  it('flags exactly one function-size, one liskov-substitution, and three switch-size', async () => {
    const go = await analyzeContent(FIXTURE_PATH, FIXTURE);
    const byRule: Record<string, number> = {};
    for (const v of go) {
      if (v.rule && MIGRATED_IDS.includes(v.rule)) {
        byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;
      }
    }
    expect(byRule['function-size']).toBe(1);
    expect(byRule['liskov-substitution']).toBe(1);
    expect(byRule['switch-size']).toBe(3);
  });
});

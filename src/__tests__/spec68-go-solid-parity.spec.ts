/**
 * Spec 68 §9 — parity: the migrated `struct-size` rule and the Go arm of
 * `interface-size` reproduce the Go binary's findings exactly.
 *
 * The Go binary (`solid.go`) reads `go/ast` and emits `struct-size` (a named
 * struct with > 15 *expanded* fields) and `interface-size` (a named interface
 * with > 10 *named methods*) at the type name's 1-based line, column 0, severity
 * `high`. The phase model re-homes that extraction into the `type-declarations`
 * producer (tree-sitter `type_spec` nodes) and re-declares the two thresholds in
 * `solid.ts`. The subtle parity points are:
 *
 *   - struct field count is *expanded*: `A, B, C int` is three fields (the Go
 *     binary appends one `Field` per `field.Names` entry), an embedded `Base`
 *     is one (`len(field.Names) == 0` appends a single embedded Field);
 *   - interface method count is named methods only: an embedded `type_elem`
 *     (`io.Reader`) is not a method (the Go binary skips `len(Names) == 0`);
 *   - line = the `type_spec` name's start line (`typeSpec.Pos().Line`), column 0.
 *
 * This test runs BOTH paths on one fixture and asserts the identity multiset on
 * `(file, line, column, rule, severity)` is equal and non-empty. The fixture
 * exercises every suppression arm: two over-threshold structs (one with grouped
 * fields), an under-threshold embedded struct, an over-threshold interface, an
 * interface of only embedded types, and a small mixed interface.
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
import type { ParsedFile, TypeDeclarationsFact, FileSymbols } from '../phase/types.js';

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

type Big struct {
	F1  string
	F2  string
	F3  string
	F4  string
	F5  string
	F6  string
	F7  string
	F8  string
	F9  string
	F10 string
	F11 string
	F12 string
	F13 string
	F14 string
	F15 string
	F16 string
}

// 16 grouped names — the Go binary expands one declaration to 16 fields.
type Grouped struct {
	A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P int
}

type Base struct {
	X int
}

// Embedded field counts as one field, not zero.
type Embedded struct {
	Base
	Value string
}

// 11 named methods — over the 10-method threshold.
type BigInterface interface {
	M1()
	M2()
	M3()
	M4()
	M5()
	M6()
	M7()
	M8()
	M9()
	M10()
	M11()
}

// 11 embedded types, 0 methods — embedded types are not methods.
type ManyEmbedded interface {
	E1
	E2
	E3
	E4
	E5
	E6
	E7
	E8
	E9
	E10
	E11
}

// One method plus one embedded type — a small interface, no finding.
type SmallInterface interface {
	EmbeddedType
	Read() int
}
`;

/** Run the migrated rules over the fixture's parsed `type-declarations` fact. */
function phaseFindings(source: string): string[] {
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(FIXTURE_PATH);
  const ast = parseFile(FIXTURE_PATH, source)!;
  const file: ParsedFile = { file: FIXTURE_PATH, format: 'go', source, ast, adapter: adapter! };
  try {
    const decl = PRODUCERS['type-declarations']['go'].process(file) as TypeDeclarationsFact[];
    const structSize = solidRules.find((r) => r.id === 'struct-size')!;
    const interfaceSize = solidRules.find((r) => r.id === 'interface-size')!;
    const findings = [
      ...(structSize.analyze({
        facts: { 'type-declarations': decl },
        formats: ['go'],
        thresholds: {},
      }) as ReturnType<typeof structSize.analyze>),
      ...(interfaceSize.analyze({
        facts: { 'file-symbols': [] as FileSymbols[], 'type-declarations': decl },
        formats: ['typescript', 'tsx', 'javascript', 'go'],
        thresholds: {},
      }) as ReturnType<typeof interfaceSize.analyze>),
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

describe('Spec 68 §9 Go SOLID parity (struct-size + interface-size)', () => {
  it('reproduces the Go binary multiset exactly and non-empty', async () => {
    const go = await analyzeContent(FIXTURE_PATH, FIXTURE);
    const old = go
      .filter((v) => v.rule === 'struct-size' || v.rule === 'interface-size')
      .map((v) => key({ file: v.file!, line: v.line, column: v.column, rule: v.rule!, severity: v.severity! }))
      .sort();

    const fresh = phaseFindings(FIXTURE);

    expect(fresh).toEqual(old);
    expect(old.length).toBeGreaterThan(0);
  });

  it('flags exactly the two big structs and the one big interface', async () => {
    const go = await analyzeContent(FIXTURE_PATH, FIXTURE);
    const byRule: Record<string, number[]> = {};
    for (const v of go) {
      if (v.rule !== 'struct-size' && v.rule !== 'interface-size') continue;
      (byRule[v.rule] ??= []).push(v.line!);
    }
    // Big (line 3) + Grouped (line 23) under struct-size; BigInterface (line 38)
    // under interface-size. The exact line numbers are the pin — a shift means
    // the producer's `type_spec` line and the Go binary's `typeSpec.Pos().Line`
    // diverged.
    expect([...(byRule['struct-size'] ?? [])].sort((a, b) => a - b)).toEqual([3, 23]);
    expect([...(byRule['interface-size'] ?? [])].sort((a, b) => a - b)).toEqual([38]);
  });
});

/**
 * Spec-49 — Go `single-responsibility` split (order #7, ledger rows 9 & 10).
 *
 * The old `single-responsibility` category claimed the Single Responsibility
 * Principle from two composite size proxies, one per entity kind:
 *
 *  - function: `countFunctionResponsibilities` = `1 + (complexity > 10) +
 *    (returnCount > 2) + (paramCount > 5)`, firing when the total exceeds 3 —
 *    i.e. only when *all three* size signals are elevated at once.
 *  - struct: `countStructResponsibilities` = `1 + fieldCountScore +
 *    mixedTypesScore`, firing when the total exceeds 5 — which the arithmetic
 *    makes impossible (max score is 4), so the struct half was dead code. Its
 *    `mixedTypes` heuristic also false-matched via `strings.Contains(field.Type,
 *    "int")`, so a `*Point` field (substring "int") counted as a numeric type.
 *
 * "Responsibility" is semantic; the syntax-only `go/parser` subprocess has no
 * cohesion/LCOM analysis, so the SRP reading is **blocked**. What remains is the
 * honest size signal, split under honest names the way `single-responsibility`
 * (TS) was split into `function-length`/`parameter-count`:
 *
 *  - `function-size` — the composite "many params + multiple returns + high
 *    complexity" reading, kept as-is (all three must be elevated).
 *  - `struct-size` — the "many fields" reading, now a *direct* `fieldCount > 10`
 *    check; the buggy `mixedTypes` substring heuristic is removed.
 *
 * Both drop the `principle: "SRP"` claim. These tests spawn the real Go binary.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);

const goDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'languages', 'go');
const binaryPath = join(goDir, 'analyzer');

interface GoViolation {
  rule?: string;
  message?: string;
}

/** Rebuild the analyzer binary from source so the test exercises current code. */
async function ensureBinaryFresh(): Promise<void> {
  try {
    await execFileAsync('go', ['build', '-o', 'analyzer', 'main.go'], { cwd: goDir });
  } catch {
    // No Go toolchain — fall through to the committed binary below.
  }
}

function analyzeContent(content: string): Promise<GoViolation[]> {
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
        params: { file: 'snippet.go', content, options: { analyzers: ['solid'] } },
        id: 1,
      }) + '\n',
    );
    child.stdin.end();
  });
}

beforeAll(async () => {
  await ensureBinaryFresh();
}, 60_000);

/** 11 if-statements (complexity 12) + 6 params + 3 returns — all three signals. */
const BIG_FUNCTION = `package main

func doEverything(a int, b int, c int, d int, e int, f int) (int, string, bool) {
	x := 0
	if a > 0 { x++ }
	if b > 0 { x++ }
	if c > 0 { x++ }
	if d > 0 { x++ }
	if e > 0 { x++ }
	if f > 0 { x++ }
	if a > 1 { x++ }
	if b > 1 { x++ }
	if c > 1 { x++ }
	if d > 1 { x++ }
	if e > 1 { x++ }
	return x, "ok", true
}
`;

/** 11 fields — over the 10-field "many fields" size threshold. */
const BIG_STRUCT = `package main

type Everything struct {
	Field1  string
	Field2  string
	Field3  string
	Field4  int
	Field5  int
	Field6  int
	Field7  string
	Field8  string
	Field9  int
	Field10 string
	Field11 string
}
`;

/** High complexity but only 2 params and 1 return — trips complexity alone. */
const COMPLEXITY_ONLY = `package main

func deep(x int) int {
	if x > 0 { x++ }
	if x > 1 { x++ }
	if x > 2 { x++ }
	if x > 3 { x++ }
	if x > 4 { x++ }
	if x > 5 { x++ }
	if x > 6 { x++ }
	if x > 7 { x++ }
	if x > 8 { x++ }
	if x > 9 { x++ }
	if x > 10 { x++ }
	return x
}
`;

/** ≤10 fields, but a field type whose name contains "int" as a substring. */
const POINTER_FIELD = `package main

type Small struct {
	Value  string
	Count  int
	Next   *Point
	Prior  *Point
	Label  string
}
`;

describe('Go single-responsibility — split into function-size / struct-size', () => {
  it('flags a big function under function-size (positive)', async () => {
    const vs = await analyzeContent(BIG_FUNCTION);
    const sized = vs.filter((v) => v.rule === 'function-size');
    expect(sized.length).toBeGreaterThanOrEqual(1);
  });

  it('flags an 11-field struct under struct-size (positive)', async () => {
    const vs = await analyzeContent(BIG_STRUCT);
    const sized = vs.filter((v) => v.rule === 'struct-size');
    expect(sized.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag a function with only high complexity — all three signals must be elevated (near-miss)', async () => {
    const vs = await analyzeContent(COMPLEXITY_ONLY);
    const sized = vs.filter((v) => v.rule === 'function-size');
    expect(sized).toHaveLength(0);
  });

  it('does NOT flag a struct whose field type merely contains "int" as a substring (near-miss)', async () => {
    const vs = await analyzeContent(POINTER_FIELD);
    const sized = vs.filter((v) => v.rule === 'struct-size');
    expect(sized).toHaveLength(0);
  });

  it('no longer emits the retired single-responsibility category (rename guard)', async () => {
    for (const code of [BIG_FUNCTION, BIG_STRUCT]) {
      const vs = await analyzeContent(code);
      const retired = vs.filter((v) => v.rule === 'single-responsibility');
      expect(retired).toHaveLength(0);
    }
  });
});

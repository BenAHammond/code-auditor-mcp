/**
 * Spec 44 — bucket 1 (rework): the three dishonest Go rules, exercised.
 *
 * The authenticity audit found three Go analyzers whose messages claimed to
 * inspect the function body but whose predicates matched only the function
 * *name* (or doc comment): `solid/liskov-substitution` ("panic" substring),
 * `errors/error-handling` ("handle"/"check"/"validate"/"verify" substring),
 * and `goroutines/concurrency` ("go"/"async"/"concurrent" substring). Each is
 * now reimplemented against `go/ast`.
 *
 * These tests are near-miss guards: for each rule, a name that would have
 * tripped the old substring proxy but whose body does NOT do the thing must
 * produce zero findings, while a body that does the thing under an innocent
 * name must produce a finding (the positive control). They spawn the real Go
 * analyzer binary over JSON-RPC — the same boundary the production pipeline
 * uses — so a reverted predicate fails the test.
 *
 * The binary at src/languages/go/analyzer is rebuilt from source before the
 * tests run (when a Go toolchain is available), so a stale committed binary
 * cannot mask a regression.
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
  details?: { function?: string };
}

interface GoResult {
  violations: GoViolation[];
}

/** Rebuild the analyzer binary from source so the test exercises current code. */
async function ensureBinaryFresh(): Promise<void> {
  try {
    await execFileAsync('go', ['build', '-o', 'analyzer', 'main.go'], { cwd: goDir });
  } catch {
    // No Go toolchain — fall through to the committed binary below.
  }
}

/** Run one Go source snippet through the analyzer and return its violations. */
function analyzeContent(content: string, analyzers: string[]): Promise<GoViolation[]> {
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
        resolve((response.result as GoResult).violations ?? []);
      } catch (err) {
        reject(new Error(`Failed to parse Go analyzer response: ${err}`));
      }
    });

    child.stdin.write(
      JSON.stringify({
        method: 'analyzeContent',
        params: { file: 'snippet.go', content, options: { analyzers } },
        id: 1,
      }) + '\n',
    );
    child.stdin.end();
  });
}

beforeAll(async () => {
  await ensureBinaryFresh();
}, 60_000);

// ══════════════════════════════════════════════════════════════════
// solid/liskov-substitution — old proxy matched "panic" in the name/doc
// ══════════════════════════════════════════════════════════════════

describe('Go solid/liskov-substitution — body panic() vs name proxy', () => {
  it('does NOT flag a method named after panic that never calls panic()', async () => {
    const code = `package main

type Parser struct{}

func (p *Parser) panicRecovery() error {
	return nil
}
`;
    const violations = await analyzeContent(code, ['solid']);
    const lsp = violations.filter((v) => v.rule === 'liskov-substitution');
    expect(lsp).toHaveLength(0);
  });

  it('flags a method that calls panic() under an innocent name', async () => {
    const code = `package main

type Parser struct{}

func (p *Parser) parse() {
	panic("unexpected token")
}
`;
    const violations = await analyzeContent(code, ['solid']);
    const lsp = violations.filter((v) => v.rule === 'liskov-substitution');
    expect(lsp.length).toBeGreaterThanOrEqual(1);
  });
});

// ══════════════════════════════════════════════════════════════════
// errors/error-handling — old proxy matched "handle"/"check"/"validate"/"verify"
// ══════════════════════════════════════════════════════════════════

describe('Go errors/error-handling — dropped err vs name proxy', () => {
  it('does NOT flag a `handle`-named function that checks its error', async () => {
    const code = `package main

import "fmt"

func handleResponse() error {
	x, err := read()
	if err != nil {
		return err
	}
	fmt.Println(x)
	return nil
}

func read() (int, error) { return 0, nil }
`;
    const violations = await analyzeContent(code, ['errors']);
    const eh = violations.filter((v) => v.rule === 'error-handling');
    expect(eh).toHaveLength(0);
  });

  it('flags an innocently-named function that drops an assigned error', async () => {
    const code = `package main

import "fmt"

func process() {
	x, err := read()
	fmt.Println(x)
}

func read() (int, error) { return 0, nil }
`;
    const violations = await analyzeContent(code, ['errors']);
    const eh = violations.filter((v) => v.rule === 'error-handling');
    expect(eh.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag a named-return error propagated by a bare return', async () => {
    // The dominant Go idiom: `func (w *W) Write(...) (n int, err error) {
    // n, err = io.Write(...); return }`. The error IS returned via the named
    // result even though no explicit `return err` appears.
    const code = `package main

import "io"

type W struct{ out io.Writer }

func (w *W) Write(data []byte) (n int, err error) {
	n, err = w.out.Write(data)
	n++
	return
}
`;
    const violations = await analyzeContent(code, ['errors']);
    const eh = violations.filter((v) => v.rule === 'error-handling');
    expect(eh).toHaveLength(0);
  });

  it('still flags a named-return function that drops an intermediate error', async () => {
    // Two assignments: the first `err` is overwritten by the second before the
    // bare return, so the first error is genuinely dropped.
    const code = `package main

import "io"

type W struct{ a, b io.Writer }

func (w *W) Write(data []byte) (err error) {
	_, err = w.a.Write(data)
	_, err = w.b.Write(data)
	return
}
`;
    const violations = await analyzeContent(code, ['errors']);
    const eh = violations.filter((v) => v.rule === 'error-handling');
    expect(eh.length).toBeGreaterThanOrEqual(1);
  });
});

// ══════════════════════════════════════════════════════════════════
// goroutines/concurrency — old proxy matched "go"/"async"/"concurrent"
// ══════════════════════════════════════════════════════════════════

describe('Go goroutines/concurrency — go statement vs name proxy', () => {
  it('does NOT flag a function with a `go`-prefixed variable but no goroutine', async () => {
    const code = `package main

import "fmt"

func loadConfig() {
	goModules := 3
	fmt.Println(goModules)
}
`;
    const violations = await analyzeContent(code, ['goroutines']);
    const conc = violations.filter((v) => v.rule === 'concurrency');
    expect(conc).toHaveLength(0);
  });

  it('flags an innocently-named function that launches a goroutine without sync', async () => {
    const code = `package main

func start() {
	go background()
}

func background() {}
`;
    const violations = await analyzeContent(code, ['goroutines']);
    const conc = violations.filter((v) => v.rule === 'concurrency');
    expect(conc.length).toBeGreaterThanOrEqual(1);
  });
});

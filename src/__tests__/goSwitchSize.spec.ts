/**
 * Spec-49 — Go `switch-size` (order #4, open-closed switch + type-switch).
 *
 * The old `open-closed` category claimed to detect the Open/Closed Principle
 * from a raw case count (`if caseCount > 5`). Case count is a size reading, not
 * an OCP reading — whether a switch is "closed to extension" depends on whether
 * it dispatches over a stable enum vs an extensible type, which the
 * syntax-only `go/parser` cannot resolve. The honest OCP computation is
 * blocked (needs type resolution); what remains is the size signal under an
 * honest name: `switch-size`.
 *
 * These tests are near-miss guards against the two failure modes a rename can
 * reintroduce:
 *   1. the proxy surviving under the old name (`open-closed` still fires), and
 *   2. the overclaiming message ("consider using polymorphism/interfaces")
 *      surviving under the new name.
 * They spawn the real Go analyzer binary over JSON-RPC — the same boundary the
 * production pipeline uses — so a reverted predicate or category fails the test.
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
  details?: { function?: string; caseCount?: number };
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
// Go switch-size — large-switch size reading (was open-closed proxy)
// ══════════════════════════════════════════════════════════════════

describe('Go switch-size — large switch/type-switch is a size reading, not open-closed', () => {
  it('flags a large switch statement under switch-size, without the polymorphism overclaim', async () => {
    const code = `package main

func dispatch(x int) int {
	switch x {
	case 1:
		return 1
	case 2:
		return 2
	case 3:
		return 3
	case 4:
		return 4
	case 5:
		return 5
	case 6:
		return 6
	case 7:
		return 7
	}
	return 0
}
`;
    const violations = await analyzeContent(code, ['solid']);
    const sized = violations.filter((v) => v.rule === 'switch-size');
    expect(sized.length).toBeGreaterThanOrEqual(1);
    // The old proxy's OCP overclaim must not survive the rename.
    expect(sized[0].message ?? '').not.toMatch(/polymorphism/i);
    expect(sized[0].message ?? '').not.toMatch(/open-?closed/i);
  });

  it('flags a large type switch under switch-size, without the interfaces overclaim', async () => {
    const code = `package main

import "fmt"

func describe(v interface{}) {
	switch v.(type) {
	case int:
		fmt.Println("int")
	case string:
		fmt.Println("string")
	case bool:
		fmt.Println("bool")
	case float64:
		fmt.Println("float64")
	case []byte:
		fmt.Println("bytes")
	case map[string]int:
		fmt.Println("map")
	case chan int:
		fmt.Println("chan")
	}
}
`;
    const violations = await analyzeContent(code, ['solid']);
    const sized = violations.filter((v) => v.rule === 'switch-size');
    expect(sized.length).toBeGreaterThanOrEqual(1);
    expect(sized[0].message ?? '').not.toMatch(/interfaces/i);
  });

  it('does NOT flag a small switch (≤5 cases) — the size threshold is the only signal', async () => {
    const code = `package main

func small(x int) int {
	switch x {
	case 1:
		return 1
	case 2:
		return 2
	case 3:
		return 3
	case 4:
		return 4
	}
	return 0
}
`;
    const violations = await analyzeContent(code, ['solid']);
    const sized = violations.filter((v) => v.rule === 'switch-size');
    expect(sized).toHaveLength(0);
  });

  it('no longer emits the retired open-closed category for a large switch', async () => {
    const code = `package main

func dispatch(x int) int {
	switch x {
	case 1:
		return 1
	case 2:
		return 2
	case 3:
		return 3
	case 4:
		return 4
	case 5:
		return 5
	case 6:
		return 6
	case 7:
		return 7
	}
	return 0
}
`;
    const violations = await analyzeContent(code, ['solid']);
    const retired = violations.filter((v) => v.rule === 'open-closed');
    expect(retired).toHaveLength(0);
  });
});

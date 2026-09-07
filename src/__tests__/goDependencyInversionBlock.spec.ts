/**
 * Spec-49 — Go `dependency-inversion` block (order #5).
 *
 * The old `dependency-inversion` category claimed to detect the Dependency
 * Inversion Principle ("depend on abstractions, not concretions") from a raw
 * field-count of `!strings.Contains(field.Type, "interface") &&
 * !strings.HasPrefix(field.Type, "*") && !isBuiltin(field.Type)`. That proxy is
 * broken on both ends: it exempts `*http.Client` ("pointers might be
 * interfaces" — false, a pointer-to-concrete is the most common concrete
 * dependency in Go), and it string-matches `"interface"` as a substring (so a
 * concrete type named `MyInterface` is exempted, and a real interface type
 * `io.Reader` is not). Whether a named field type is an interface or a concrete
 * type cannot be answered by `go/parser` — it needs type resolution.
 *
 * The honest DIP computation is therefore **blocked**, not faked. The proxy is
 * removed; the Go analyzer no longer emits `dependency-inversion`. (The TS
 * `solid/dependency-inversion` rule is a different, already-honest computation —
 * `new PascalCaseNonBuiltinNonSelf()` instantiation — and is untouched.)
 *
 * These tests spawn the real Go binary to guard against the proxy silently
 * surviving the removal under the old name or a renamed one.
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
  category?: string;
  message?: string;
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
// Go dependency-inversion — the concrete-field-count proxy is removed
// ══════════════════════════════════════════════════════════════════

describe('Go dependency-inversion — blocked (needs type resolution), proxy removed', () => {
  it('does NOT emit dependency-inversion for a struct with many concrete fields', async () => {
    const code = `package main

type User struct{ Name string }
type Order struct{ ID int }
type Product struct{ SKU string }
type Payment struct{ Amount int }

type Service struct {
	user    User
	order   Order
	product Product
	payment Payment
}
`;
    const violations = await analyzeContent(code, ['solid']);
    const dip = violations.filter((v) => v.category === 'dependency-inversion');
    expect(dip).toHaveLength(0);
  });

  it('does NOT emit a renamed proxy for the same struct', async () => {
    const code = `package main

type User struct{ Name string }
type Order struct{ ID int }
type Product struct{ SKU string }
type Payment struct{ Amount int }

type Service struct {
	user    User
	order   Order
	product Product
	payment Payment
}
`;
    const violations = await analyzeContent(code, ['solid']);
    // Any category that re-brands the same proxy would show up here; the honest
    // outcome is no dependency/field-count finding at all.
    const proxyish = violations.filter((v) =>
      /dependency|concrete|field-count/i.test(v.category ?? '')
    );
    expect(proxyish).toHaveLength(0);
  });

  it('still runs the rest of the solid analyzer (large interface → interface-size)', async () => {
    const code = `package main

type Machine interface {
	Print()
	Scan()
	Fax()
	Staple()
	Collate()
	Bind()
	Laminate()
}
`;
    const violations = await analyzeContent(code, ['solid']);
    const sized = violations.filter((v) => v.category === 'interface-size');
    expect(sized.length).toBeGreaterThanOrEqual(1);
  });
});

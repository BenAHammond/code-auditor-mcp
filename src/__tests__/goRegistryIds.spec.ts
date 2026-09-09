/**
 * Go registry-IDs smoke test — pin the Go subprocess's emitted rule IDs against
 * a Gin-style fixture.
 *
 * The Go analyzer binary emits its own `analyzer` + `rule` identifiers
 * (self-contained severity/message — it does not read the TS `RULE_REGISTRY`).
 * Those strings are a de-facto registry: the TS side (`verify-languages.mjs`
 * `GO_ANALYZERS`, the polyglot orchestrator's `analyzerResults` bucketing, and
 * the coverage/gate path) keys on them. A Go-side rename or a silently dropped
 * analyzer would change the emitted set without any TS test noticing — the
 * findings still render, just under an ID nobody classifies.
 *
 * This test closes that gap (open since the Go subprocess split) the way the
 * first `verify:languages` guard closed the `.go`-fed-to-TS-analyzer gap: run
 * the real binary on a fixture that exercises every analyzer, then assert the
 * emitted IDs are exactly the known set.
 *
 * Two assertions together make drift impossible to miss:
 *   1. every emitted `analyzer/rule` is in the canonical set (no unknown ID), and
 *   2. every canonical ID is emitted (the fixture hits all ten — a rename or a
 *      dropped analyzer leaves a hole).
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
  analyzer?: string;
  rule?: string;
}

/**
 * The Go subprocess's full emitted registry. Keep this in lockstep with
 * `src/languages/go/analyzer-src/*.go` (`Analyzer:` / `Rule:` literals) — a new
 * Go rule is a new entry here, or the "every canonical ID is emitted" assertion
 * below will still pass while the new ID goes un-pinned.
 */
const GO_REGISTRY_IDS = new Set([
  'solid/function-size',
  'solid/struct-size',
  'solid/switch-size',
  'solid/liskov-substitution',
  'solid/interface-size',
  'imports/import-style',
  'imports/import-organization',
  'errors/error-handling',
  'goroutines/concurrency',
  'channels/channel-deadlock',
]);

// A Gin-style file that touches every Go analyzer: dot + mis-grouped imports,
// a dropped error, an unsynchronized goroutine, a same-goroutine channel
// deadlock, and each of the five solid readings. The analyzer parses it
// syntactically, so the gin import needs no real dependency.
const GIN_SOURCE = `package main

import (
    "os"
    "net/http"
    "github.com/gin-gonic/gin"
    . "fmt"
)

type BigStruct struct {
    A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P string
    AA, AB, AC, AD, AE, AF, AG, AH, AI, AJ int
}

type HugeInterface interface {
    Method1() int
    Method2() int
    Method3() int
    Method4() int
    Method5() int
    Method6() int
    Method7() int
    Method8() int
    Method9() int
    Method10() int
    Method11() int
    Method12() int
}

type Service struct{}

func (s *Service) Do() {
    panic("not implemented")
}

func droppedError() {
    f, err := os.Open("x")
    f.Close()
}

func fireAndForget() {
    go background()
}

func background() {}

func deadlock() {
    ch := make(chan int)
    ch <- 1
    <-ch
}

func bigSwitch(n int) string {
    switch n {
    case 1: return "one"
    case 2: return "two"
    case 3: return "three"
    case 4: return "four"
    case 5: return "five"
    case 6: return "six"
    case 7: return "seven"
    case 8: return "eight"
    case 9: return "nine"
    case 10: return "ten"
    case 11: return "eleven"
    case 12: return "twelve"
    case 13: return "thirteen"
    case 14: return "fourteen"
    case 15: return "fifteen"
    default: return "many"
    }
}

func complexFunc(p1, p2, p3, p4, p5, p6 int) (int, int, int) {
    x := p1
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
    if x > 11 { x++ }
    return x, p2, p3
}

func router() {
    r := gin.Default()
    r.GET("/ping", func(c *gin.Context) { c.JSON(200, gin.H{"m": "pong"}) })
    http.ListenAndServe(":8080", r)
}
`;

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
        params: {
          file: 'gin.go',
          content,
          options: { analyzers: ['solid', 'imports', 'errors', 'goroutines', 'channels'] },
        },
        id: 1,
      }) + '\n',
    );
    child.stdin.end();
  });
}

beforeAll(async () => {
  await ensureBinaryFresh();
}, 60_000);

describe('Go registry IDs — gin smoke test', () => {
  it('emits only the known analyzer/rule IDs', async () => {
    const violations = await analyzeContent(GIN_SOURCE);
    const emitted = new Set(violations.map((v) => `${v.analyzer}/${v.rule}`));
    const unknown = [...emitted].filter((id) => !GO_REGISTRY_IDS.has(id));
    expect(unknown, `Go subprocess emitted unregistered ID(s): ${unknown.join(', ')}`).toEqual([]);
  });

  it('emits every canonical ID (no dropped analyzer or renamed rule)', async () => {
    const violations = await analyzeContent(GIN_SOURCE);
    const emitted = new Set(violations.map((v) => `${v.analyzer}/${v.rule}`));
    const missing = [...GO_REGISTRY_IDS].filter((id) => !emitted.has(id));
    expect(missing, `fixture no longer exercises: ${missing.join(', ')} — a rule was renamed or its analyzer dropped`).toEqual([]);
  });
});

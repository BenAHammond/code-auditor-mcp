/**
 * Spec-49 — Go `channels/concurrency` (order #7 remainder, ledger row 20).
 *
 * The old predicate was `if containsChannel(function.Signature) &&
 * function.Complexity > 3` — a signature substring ("chan") plus a cyclomatic
 * complexity count — standing in for "potential deadlock". Neither signal is a
 * deadlock: a function whose signature mentions a channel is not deadlocking, and
 * a 3-statement function can deadlock. The authenticity ledger's `gap` column
 * says: "Potential deadlocks is claimed but not computed — no analysis of
 * send/recv blocking."
 *
 * The bridgeable, honest signal is the *provable* same-goroutine deadlock: a
 * channel created unbuffered (`make(chan T)` with no buffer) that is both sent to
 * and received from (or operated on twice) in the same function with no `go`
 * statement anywhere in the body. An unbuffered send blocks until a receiver is
 * ready; if the receiver (and the sender, for a receive-first) lives in the same
 * goroutine with no `go` to spawn a counterpart, the first operation blocks
 * before the second can run — a guaranteed deadlock, independent of any external
 * code.
 *
 * The broader deadlock detection (cross-goroutine blocking, channel-escape
 * analysis) is `blocked` — it needs inter-procedural escape/dataflow analysis the
 * syntax-only `go/parser` subprocess lacks. This rule keeps the provable subset
 * under an honest name (`channel-deadlock`), and drops the "potential deadlock"
 * overclaim and the signature-substring + complexity proxy.
 *
 * These tests spawn the real Go binary.
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

/** Rebuild the analyzer binary from source so the test exercises current code. */
async function ensureBinaryFresh(): Promise<void> {
  try {
    await execFileAsync('go', ['build', '-o', 'analyzer', 'main.go'], { cwd: goDir });
  } catch {
    // No Go toolchain — fall through to the committed binary below.
  }
}

function analyzeContent(content: string, analyzers: string[] = ['channels']): Promise<GoViolation[]> {
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

/** Unbuffered channel both sent to and received from, no `go` — deadlock. */
const DEADLOCK = `package main

func deadlock() {
	ch := make(chan int)
	ch <- 1
	<-ch
}
`;

/** Signature mentions a channel and complexity > 3, but the goroutine pattern is
 *  safe — trips the old proxy, must not fire the new rule. */
const SAFE_CHAN_SIGNATURE = `package main

func fetch(done chan bool) int {
	result := make(chan int)
	go func() { result <- 42 }()
	v := <-result
	if v > 0 {
		v++
	}
	if v > 1 {
		v++
	}
	if done != nil {
		_ = done
	}
	return v
}
`;

/** A real deadlock too simple for the old proxy — no "chan" in signature,
 *  complexity 1. The old rule never fired here; the new rule must. */
const SIMPLE_DEADLOCK = `package main

func hang() {
	ch := make(chan int)
	ch <- 1
	<-ch
}
`;

/** Buffered channel — the send does not block, so send-then-receive is safe. */
const BUFFERED = `package main

func ok() {
	ch := make(chan int, 1)
	ch <- 1
	<-ch
}
`;

describe('Go channels — same-goroutine unbuffered deadlock, not signature+complexity', () => {
  it('flags an unbuffered send+receive with no goroutine under channel-deadlock (positive)', async () => {
    const vs = await analyzeContent(DEADLOCK);
    const dl = vs.filter((v) => v.category === 'channel-deadlock');
    expect(dl.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag a safe channel function (chan signature + complexity>3, has go) (near-miss)', async () => {
    const vs = await analyzeContent(SAFE_CHAN_SIGNATURE);
    const dl = vs.filter((v) => v.category === 'channel-deadlock');
    expect(dl).toHaveLength(0);
  });

  it('flags a simple deadlock the old proxy missed — no chan in signature, complexity 1 (inverse near-miss)', async () => {
    const vs = await analyzeContent(SIMPLE_DEADLOCK);
    const dl = vs.filter((v) => v.category === 'channel-deadlock');
    expect(dl.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag a buffered channel send+receive — the send does not block (near-miss)', async () => {
    const vs = await analyzeContent(BUFFERED);
    const dl = vs.filter((v) => v.category === 'channel-deadlock');
    expect(dl).toHaveLength(0);
  });

  it('no longer emits the retired concurrency category for the channels analyzer (rename guard)', async () => {
    for (const code of [DEADLOCK, SAFE_CHAN_SIGNATURE]) {
      const vs = await analyzeContent(code);
      const retired = vs.filter((v) => v.category === 'concurrency');
      expect(retired).toHaveLength(0);
    }
  });
});

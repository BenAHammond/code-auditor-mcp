/**
 * Spec 66 R2 — the Go side runs its full six-group set, not the four-group
 * slice the dispatch used to send.
 *
 * The old GoAnalyzer hardcoded `['solid', 'imports', 'errors', 'data-access']`,
 * dropping `goroutines` (→ `concurrency`, severe) and `channels` (→
 * `channel-deadlock`, critical). Both analyzers were fully implemented in the
 * Go subprocess — they were dead by *omission from a list*, not by absence of
 * code. The dispatch must now request all six groups, so a mixed repo with a
 * same-goroutine deadlock and an unsynchronized goroutine surfaces both rules
 * at the severity the registry promises.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { runAuditDispatch } from '../auditRouter.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ca-spec66-r2-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// `launch` fires `concurrency` (a `go` statement with no sync), `deadlock` fires
// `channel-deadlock` (unbuffered send + receive, no `go`).
const GO_FIXTURE = `package main

import "fmt"

func launch() {
	go fmt.Println("hello")
}

func deadlock() {
	ch := make(chan int)
	ch <- 1
	<-ch
}
`;

describe('Spec 66 R2 — full Go group set reaches the subprocess', () => {
  it('fires channel-deadlock (critical) and concurrency (severe) through the dispatch', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'main.go'), GO_FIXTURE);
      await writeFile(join(dir, 'a.ts'), 'export const x = 1;\n');
      const result = await runAuditDispatch({ projectRoot: dir, writeToLedger: false } as any);

      const all = Object.values(result.analyzerResults).flatMap((ar) => ar.violations);
      const byRule = new Map(all.map((v) => [v.rule, v]));

      expect(byRule.has('channel-deadlock')).toBe(true);
      expect(byRule.get('channel-deadlock')!.severity).toBe('critical');
      expect(byRule.has('concurrency')).toBe(true);
      expect(byRule.get('concurrency')!.severity).toBe('severe');
    });
  }, 30000);
});

/**
 * Task #255 regression test — the stdio MCP entry point must dispatch languages.
 *
 * `mcp.ts`'s `audit.run` and `audit.health` handlers used to build a
 * `createAuditRunner` directly, bypassing `runAuditDispatch`, so a `.go` file
 * was never routed to the Go subprocess and every Go rule read `notApplicable`
 * instead of actually running. Task #255 is that hole.
 *
 * This test enumerates the real handlers: it builds the tool registry via
 * `registerAllTools` and dispatches `audit.run` (coverage state) and
 * `audit.health` (metrics) against a temp repo containing a Go file. Written
 * red-first: before the fix, `createAuditRunner` marks the Go rules
 * `notApplicable` (run) and drops the Go violation from the health metrics.
 *
 * This is NOT Spec 66 R5 (entry-point coverage conformance, which must
 * enumerate every entry point and account for all 100 registry rules). It is a
 * scoped regression test for #255 on the two audit handlers only.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { ToolRegistry } from '../tool-registry.js';
import { registerAllTools } from '../mcp.js';
import { RULE_REGISTRY } from '../analyzers/ruleRegistry.js';

/**
 * The Go-subprocess-only rules, derived from the registry rather than re-typed:
 * every rule whose `analyzer` is `go`. These have no TypeScript visitor — they
 * are produced solely by the Go analyzer, so on a repo with a `.go` file they
 * are the canary: `runAuditDispatch` runs them (fired/clean), `createAuditRunner`
 * never does (notApplicable). Derived so a sixth Go rule added to the registry
 * is asserted automatically instead of waiting for this literal list to drift.
 */
const GO_RULES = Object.entries(RULE_REGISTRY)
  .filter(([, entry]) => entry.analyzer === 'go')
  .map(([ruleId]) => ruleId);

// Fires `channel-deadlock` (critical) and `concurrency` (severe) — both
// Go-subprocess-only, so a health check that dispatches Go sees a critical;
// one that skips Go sees zero criticals from a clean TS file.
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

// Isolate the code index / ledger from the shared dev cache so the dispatch's
// DB writes land in a throwaway dir (styles index-state-dependence, #256, is a
// real hazard for cross-test contamination).
let dataDir: string;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  dataDir = await mkdtemp(join(tmpdir(), 'ca-spec66-r5-mcp-'));
  process.env.CODE_AUDITOR_DATA_DIR = dataDir;
});

afterAll(async () => {
  delete process.env.CODE_AUDITOR_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

async function withTempRepo(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ca-spec66-r5-repo-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('Task #255 — stdio MCP audit.run dispatches Go', () => {
  it('audit.run on a repo with a .go file: Go rules are fired/clean, not notApplicable', async () => {
    await withTempRepo(async (dir) => {
      await writeFile(join(dir, 'a.ts'), 'export const x = 1;\n');
      // A Go file that actually violates a rule (ignored error + bare goroutine)
      // so a successful dispatch produces at least one `fired`, not just `clean`.
      await writeFile(
        join(dir, 'main.go'),
        'package main\n\nimport "os"\n\nfunc main() {\n\tf, _ := os.Create("x")\n\t_ = f\n\tgo runAsync()\n}\n\nfunc runAsync() {}\n',
      );

      const registry = new ToolRegistry();
      registerAllTools(registry);
      const result = (await registry.dispatch('audit', 'run', {
        path: dir,
        indexFunctions: false,
      }, undefined)) as {
        metadata?: { coverage?: Array<{ ruleId: string; state: string }> };
      };

      const byRule = new Map((result.metadata?.coverage ?? []).map((c) => [c.ruleId, c.state]));
      const ran = new Set(['fired', 'clean']);
      for (const rule of GO_RULES) {
        const state = byRule.get(rule);
        expect(
          state !== undefined && ran.has(state),
          `Go rule "${rule}" must be dispatched (fired|clean), got "${state}"`,
        ).toBe(true);
      }
    });
  }, 60000);

  it('audit.health on a repo with a .go file: Go violation lands in the metrics', async () => {
    await withTempRepo(async (dir) => {
      await writeFile(join(dir, 'a.ts'), 'export const x = 1;\n');
      await writeFile(join(dir, 'main.go'), GO_FIXTURE);

      const registry = new ToolRegistry();
      registerAllTools(registry);
      const result = (await registry.dispatch('audit', 'health', {
        path: dir,
        indexFunctions: false,
        generateCodeMap: false,
      }, undefined)) as {
        metrics?: { filesAnalyzed: number; criticalViolations: number };
      };

      // `channel-deadlock` is a critical, Go-only rule. A dispatched Go half
      // produces it; a skipped Go half (the old `createAuditRunner` path)
      // produces zero criticals from the clean `a.ts`.
      expect(result.metrics?.criticalViolations ?? 0).toBeGreaterThanOrEqual(1);
      // Both files were audited: the `.go` file counted alongside the `.ts`.
      expect(result.metrics?.filesAnalyzed ?? 0).toBeGreaterThanOrEqual(2);
    });
  }, 60000);
});

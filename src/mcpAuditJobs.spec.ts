import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { derivePartitionPlan, __testables } from './mcpAuditJobs.js';
import { makeVisitorStatus } from './pipeline.js';

describe('mcpAuditJobs partition planning', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'code-auditor-partition-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns none when input is a file audit', async () => {
    const plan = await derivePartitionPlan(
      { partitionStrategy: 'top-level' },
      dir,
      true,
      ['react', 'dry']
    );
    expect(plan.mode).toBe('none');
    expect(plan.partitionPaths).toEqual([]);
  });

  it('auto mode skips partitioning below threshold', async () => {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1;');

    const plan = await derivePartitionPlan(
      { partitionStrategy: 'auto', partitionThresholdFiles: 1000 },
      dir,
      false,
      ['react', 'dry']
    );
    expect(plan.mode).toBe('none');
    expect(plan.partitionPaths).toEqual([]);
  });

  it('top-level mode partitions app/src and splits global analyzers', async () => {
    await mkdir(join(dir, 'app'), { recursive: true });
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'app', 'a.tsx'), 'export const A = () => null;');
    await writeFile(join(dir, 'src', 'b.tsx'), 'export const B = () => null;');

    const plan = await derivePartitionPlan(
      { partitionStrategy: 'top-level', maxPartitions: 4, partitionThresholdFiles: 1 },
      dir,
      false,
      ['react', 'dry', 'documentation', 'data-access']
    );

    expect(plan.mode).toBe('top-level');
    expect(plan.partitionPaths).toContain(join(dir, 'app'));
    expect(plan.partitionPaths).toContain(join(dir, 'src'));
    expect(plan.globalAnalyzers.sort()).toEqual(['data-access', 'dry']);
    expect(plan.shardedAnalyzers.sort()).toEqual(['documentation', 'react']);
  });

  it('classifies retryable shard errors', () => {
    expect(__testables.isRetryableShardError('Shard timed out after 60000ms')).toBe(true);
    expect(__testables.isRetryableShardError('ECONNRESET while reading file list')).toBe(true);
    expect(__testables.isRetryableShardError('Syntax error in analyzer config')).toBe(false);
  });

  it('dedupes duplicate violations while merging analyzer results', () => {
    const merged = __testables.mergeAnalyzerResult(
      {
        violations: [
          {
            type: 'dup',
            severity: 'warning',
            file: 'src/a.ts',
            line: 10,
            message: 'duplicate',
            rule: 'dup-rule',
          },
        ],
        status: makeVisitorStatus(1),
        executionTime: 2,
        errors: [],
      },
      {
        violations: [
          {
            type: 'dup',
            severity: 'warning',
            file: 'src/a.ts',
            line: 10,
            message: 'duplicate',
            rule: 'dup-rule',
          },
          {
            type: 'other',
            severity: 'suggestion',
            file: 'src/a.ts',
            line: 12,
            message: 'other issue',
            rule: 'other-rule',
          },
        ],
        status: makeVisitorStatus(1),
        executionTime: 3,
        errors: [],
      }
    );

    expect(merged.violations).toHaveLength(2);
    expect(merged.status.status === 'visitor-ran' ? merged.status.filesProcessed : 0).toBe(2);
    expect(merged.executionTime).toBe(5);
  });

  it('derives fired coverage counts from merged deduped violations (not summed shard counts)', () => {
    // cross-domain is a DB-based analyzer that ignores shard scope: each of 4
    // shards emits the same 21 full-project findings. Summing their coverage
    // counts would yield 84; the deduped merged violations below have 21.
    const rule = 'cross-domain/read-never-written';
    const shardViolation = (file: string): any => ({
      file,
      rule,
      severity: 'warning',
      message: `Table read but never written (${file})`,
    });
    const shards = Array.from({ length: 4 }, (_, i) => ({
      metadata: {
        coverage: [
          { ruleId: rule, analyzer: 'cross-domain', state: 'fired', count: 21 },
        ],
      },
    }));
    // All 4 shards report the same 21 violations (same file:line:message).
    const dedupedViolations = Array.from({ length: 21 }, (_, i) => shardViolation(`src/a.ts:${i}`));
    const ordered = { 'cross-domain': { violations: dedupedViolations } as any };

    const merged = __testables.mergeCoverage(shards as any, ordered);
    expect(merged).toBeDefined();
    const row = merged!.find((r) => r.ruleId === rule && r.analyzer === 'cross-domain');
    expect(row).toBeDefined();
    expect(row!.state).toBe('fired');
    expect(row!.count).toBe(21);
  });

  it('sums distinct per-shard findings for genuinely sharded analyzers', () => {
    // A sharded analyzer (solid) emits disjoint findings per partition: shard 1
    // has 2, shard 2 has 3 — the merged deduped set has 5 distinct violations.
    const rule = 'solid/single-responsibility';
    const shards = [
      {
        metadata: {
          coverage: [
            { ruleId: rule, analyzer: 'solid', state: 'fired', count: 2 },
          ],
        },
      },
      {
        metadata: {
          coverage: [
            { ruleId: rule, analyzer: 'solid', state: 'fired', count: 3 },
          ],
        },
      },
    ];
    const v = (file: string): any => ({ file, rule, severity: 'warning', message: `SRP (${file})` });
    const ordered = {
      solid: {
        violations: [v('src/a.ts'), v('src/b.ts'), v('src/c.ts'), v('src/d.ts'), v('src/e.ts')],
      } as any,
    };

    const merged = __testables.mergeCoverage(shards as any, ordered);
    const row = merged!.find((r) => r.ruleId === rule && r.analyzer === 'solid');
    expect(row!.state).toBe('fired');
    expect(row!.count).toBe(5);
  });
});

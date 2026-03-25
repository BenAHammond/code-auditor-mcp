import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { derivePartitionPlan, __testables } from './mcpAuditJobs.js';

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
        filesProcessed: 1,
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
        filesProcessed: 1,
        executionTime: 3,
        errors: [],
      }
    );

    expect(merged.violations).toHaveLength(2);
    expect(merged.filesProcessed).toBe(2);
    expect(merged.executionTime).toBe(5);
  });
});

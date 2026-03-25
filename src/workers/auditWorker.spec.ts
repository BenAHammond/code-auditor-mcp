import { describe, expect, it } from 'vitest';
import { continuationConfigAfterHandoff, toAuditRunnerOptions } from './auditWorkerProtocol.js';

describe('audit worker protocol', () => {
  it('maps serializable config to runner options', () => {
    const options = toAuditRunnerOptions({
      projectRoot: '/tmp/project',
      includePaths: ['/tmp/project/src/**/*'],
      excludePaths: ['**/*.test.ts'],
      fileExtensions: ['.ts'],
      minSeverity: 'warning',
      enabledAnalyzers: ['solid', 'react'],
      indexFunctions: true,
      analyzerConfigs: { solid: { maxMethodsPerClass: 20 } },
      analyzerConcurrency: 3,
    });

    expect(options.projectRoot).toBe('/tmp/project');
    expect(options.includePaths).toEqual(['/tmp/project/src/**/*']);
    expect(options.excludePaths).toEqual(['**/*.test.ts']);
    expect(options.fileExtensions).toEqual(['.ts']);
    expect(options.minSeverity).toBe('warning');
    expect(options.enabledAnalyzers).toEqual(['solid', 'react']);
    expect(options.indexFunctions).toBe(true);
    expect(options.analyzerConfigs).toEqual({ solid: { maxMethodsPerClass: 20 } });
    expect(options.analyzerConcurrency).toBe(3);
  });

  it('handoff continuation uses explicitFiles and drops includePaths', () => {
    const cont = continuationConfigAfterHandoff(
      {
        projectRoot: '/proj',
        includePaths: ['/proj/src/**/*'],
        enabledAnalyzers: ['solid'],
        maxFilesPerRun: 100,
        shardSoftBudgetMs: 60_000,
      },
      ['/proj/b.ts', '/proj/a.ts']
    );
    expect(cont.includePaths).toBeUndefined();
    expect(cont.explicitFiles).toEqual(['/proj/b.ts', '/proj/a.ts']);
    expect(cont.maxFilesPerRun).toBe(100);
    expect(cont.shardSoftBudgetMs).toBe(60_000);
  });
});

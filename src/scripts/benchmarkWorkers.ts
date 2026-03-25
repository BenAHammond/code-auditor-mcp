import path from 'node:path';
import { startAuditJob, getAuditJobStatus, getAuditResultsPage } from '../mcpAuditJobs.js';

type Scenario = {
  name: string;
  args: Record<string, unknown>;
};

const defaults = {
  defaultAnalyzers: ['solid', 'dry', 'react', 'documentation', 'data-access'],
  defaultMinSeverity: 'warning' as const,
  defaultGenerateCodeMap: false,
};

async function waitForResult(jobId: string): Promise<{ elapsedMs: number; resultId: string }> {
  const started = Date.now();
  for (;;) {
    const status = getAuditJobStatus(jobId) as Record<string, unknown>;
    if (status.status === 'failed') {
      throw new Error(`Job ${jobId} failed: ${String(status.error ?? 'unknown error')}`);
    }
    if (status.status === 'completed' && typeof status.resultId === 'string') {
      return { elapsedMs: Date.now() - started, resultId: status.resultId };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function runScenario(basePath: string, scenario: Scenario): Promise<void> {
  const started = Date.now();
  const startedJob = await startAuditJob(
    {
      path: basePath,
      indexFunctions: false,
      generateCodeMap: false,
      ...scenario.args,
    },
    defaults
  );
  const { elapsedMs, resultId } = await waitForResult(startedJob.jobId);
  const page = await getAuditResultsPage({ resultId, limit: 1, offset: 0 });
  const summary = page.summary as Record<string, unknown>;
  const violations = Number(summary.totalViolations ?? 0);
  const files = Number(summary.filesAnalyzed ?? 0);
  const totalElapsed = Date.now() - started;

  console.log(
    JSON.stringify({
      scenario: scenario.name,
      path: basePath,
      jobId: startedJob.jobId,
      resultId,
      filesAnalyzed: files,
      totalViolations: violations,
      elapsedMs,
      totalElapsedMs: totalElapsed,
    })
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const targetPath = path.resolve(args[0] || process.cwd());
  const scenarios: Scenario[] = [
    {
      name: 'single-worker-no-partition',
      args: { partitionStrategy: 'none', workerCount: 1, maxRetries: 0 },
    },
    {
      name: 'multi-worker-auto-partition',
      args: { partitionStrategy: 'auto', workerCount: 4, maxRetries: 1, partitionThresholdFiles: 50 },
    },
  ];

  for (const scenario of scenarios) {
    await runScenario(targetPath, scenario);
  }
}

void main();

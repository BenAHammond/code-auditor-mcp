import { initParsers, initializeLanguages } from '../languages/index.js';
import { runAuditJob } from '../mcpAuditJobs.js';
import { CodeIndexDB } from '../codeIndexDB.js';

/**
 * Forkable entrypoint for Spec 41 `--detach`.
 *
 * Reads jobId / args / defaults from argv, initializes parsers, and runs the
 * shared `runAuditJob` path — the same path MCP's `audit.start` schedules via
 * setTimeout. There is no second runner: the child exists only to give `--detach`
 * a detached process whose stderr the parent captures to a per-run log.
 *
 * `runAuditJob` records lifecycle state (including failure) on the run row and
 * resolves normally, so this process exits non-zero only when `runAuditJob`
 * itself rejects before its own try/catch takes over (e.g. a broken argv).
 */
async function main(): Promise<void> {
  const [, , jobId, argsJson, defaultsJson] = process.argv;
  if (!jobId || !argsJson || !defaultsJson) {
    console.error('usage: auditJobRunner <jobId> <argsJson> <defaultsJson>');
    process.exitCode = 2;
    return;
  }

  initializeLanguages();
  await initParsers();

  // This process is a fresh fork of a parent that already opened CodeIndexDB.
  // fork() copies the singleton (including `isInitialized = true` and a native
  // better-sqlite3 handle that does not survive the fork), so `getInstance`
  // would short-circuit and hand back a dead connection. Reset the singleton so
  // runAuditJob opens a fresh per-project connection.
  CodeIndexDB.resetInstance();

  await runAuditJob(jobId, JSON.parse(argsJson) as Record<string, unknown>, JSON.parse(defaultsJson) as never);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});

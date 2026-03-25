/**
 * CLI harness: discover + extract functions + sync to index without MCP stdio.
 * Usage: node dist/mcp-index.js --auto-index /path/to/project
 */
import path from 'node:path';
import { createAuditRunner } from './auditRunner.js';
import { syncFileIndex } from './codeIndexService.js';
import { CodeIndexDB } from './codeIndexDB.js';
import { logMcpInfo } from './mcpDiagnostics.js';

export async function runAutoIndex(projectPath: string): Promise<void> {
  const root = path.resolve(projectPath);
  logMcpInfo('auto-index', 'start', {
    projectPath: root,
    cwd: process.cwd(),
    dataDir: process.env.CODE_AUDITOR_DATA_DIR ?? '(default: cwd/.code-index)'
  });

  const db = CodeIndexDB.getInstance();
  await db.initialize();
  logMcpInfo('auto-index', 'database ready', {});

  const runner = createAuditRunner({
    projectRoot: root,
    enabledAnalyzers: [],
    indexFunctions: true,
    minSeverity: 'warning',
    verbose: false,
    progressCallback: (p) => {
      if (
        p.phase === 'function-indexing' &&
        typeof p.current === 'number' &&
        typeof p.total === 'number' &&
        p.total > 0 &&
        p.current % 50 !== 0 &&
        p.current !== p.total
      ) {
        return;
      }
      logMcpInfo('auto-index', 'runner progress', {
        phase: p.phase,
        message: p.message,
        analyzer: p.analyzer,
        current: p.current,
        total: p.total
      });
    }
  });

  const auditResult = await runner.run();
  const map = auditResult.metadata.fileToFunctionsMap;
  if (!map || Object.keys(map).length === 0) {
    logMcpInfo('auto-index', 'no files to sync (empty fileToFunctionsMap)', {
      filesAnalyzed: auditResult.metadata.filesAnalyzed
    });
    return;
  }

  const entries = Object.entries(map);
  logMcpInfo('auto-index', 'syncing files to index', { fileCount: entries.length });

  let synced = 0;
  const syncStats = { added: 0, updated: 0, removed: 0 };
  for (const [filePath, functions] of entries) {
    synced++;
    if (synced % 50 === 0 || synced === entries.length) {
      logMcpInfo('auto-index', 'sync progress', { current: synced, total: entries.length });
    }
    const fileStats = await syncFileIndex(filePath, functions);
    syncStats.added += fileStats.added;
    syncStats.updated += fileStats.updated;
    syncStats.removed += fileStats.removed;
  }

  logMcpInfo('auto-index', 'done', {
    ...syncStats,
    durationMs: auditResult.metadata.auditDuration
  });
}

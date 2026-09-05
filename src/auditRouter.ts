/**
 * Audit router — the single entry point for choosing between the two analysis
 * paths: the tree-sitter TypeScript pipeline (`createAuditRunner`) and the Go
 * subprocess orchestrator (`LanguageOrchestrator`).
 *
 * The CLI and the MCP `audit.run` tool both need the same decision — "are there
 * Go files? route to the Go subprocess; otherwise use the TS pipeline" — and
 * for months they did not share it: `handleAudit` checked for `.go` and routed
 * to the orchestrator, while the CLI called `createAuditRunner` directly and
 * fed Go ASTs to TypeScript-tuned analyzers (the 762-finding gin result). Two
 * copies, one silently wrong — the same shape as the duplicate
 * `getLanguageFromPath`, one layer up.
 *
 * This module is that decision, in exactly one place. Both surfaces call
 * `runAuditDispatch`; a future refactor that unwires one of them can no longer
 * silently break the other.
 */

import * as path from 'path';
import { promises as fs } from 'fs';
import { AuditResult, AuditRunnerOptions } from './types.js';
import { createAuditRunner } from './auditRunner.js';
import { RuntimeManager } from './languages/RuntimeManager.js';
import { LanguageOrchestrator, PolyglotAnalysisOptions } from './languages/LanguageOrchestrator.js';
import { CodeIndexDB } from './codeIndexDB.js';
import { makeVisitorStatus } from './pipeline.js';

/**
 * True when `target` (a file or directory) is, or contains, a file with the
 * given extension. Walked recursively for directories.
 */
export async function hasFilesWithExtension(target: string, ext: string): Promise<boolean> {
  try {
    const stats = await fs.stat(target);
    if (stats.isFile()) {
      return path.extname(target).toLowerCase() === ext;
    }
    const entries = await fs.readdir(target, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        if (path.extname(entry.name).toLowerCase() === ext) return true;
      } else if (entry.isDirectory()) {
        if (await hasFilesWithExtension(path.join(target, entry.name), ext)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Convert a polyglot analysis result to the legacy `AuditResult` shape the
 * reporting and CLI surfaces consume.
 */
export function convertPolyglotToAuditResult(polyglotResult: any, auditPath: string): AuditResult {
  const violations = polyglotResult.violations || [];
  const criticalIssues = violations.filter((v: any) => v.severity === 'critical').length;
  const warnings = violations.filter((v: any) => v.severity === 'warning').length;
  const suggestions = violations.filter((v: any) => v.severity === 'suggestion').length;
  const totalFiles = polyglotResult.metrics?.totalFiles || 0;
  const executionTime = polyglotResult.metrics?.executionTime || 0;

  // Bucket violations by their category for the summary. The Go subprocess
  // labels findings with `category` (open-closed, import-style, …); the
  // TypeScript pipeline uses `type` for the same purpose. Fall back to the
  // analyzer label so a categoryless finding still lands in a real bucket
  // rather than vanishing into an empty `violationsByCategory`.
  const violationsByCategory: Record<string, number> = {};
  for (const v of violations) {
    const category = v.category || v.type || v.analyzer || 'unknown';
    violationsByCategory[category] = (violationsByCategory[category] || 0) + 1;
  }
  const topIssues = Object.entries(violationsByCategory)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([type, count]) => ({ type, count }));

  // Build analyzerResults dynamically from the actual analyzer labels on the
  // violations. The Go subprocess labels findings with the analyzer that
  // produced them (`solid`, and potentially `imports`/`errors`/`goroutines`/
  // `channels`) — never `go`. A hardcoded `go` bucket filtering
  // `v.analyzer === 'go'` was therefore structurally always zero.
  const analyzerResults: Record<string, any> = {};
  for (const v of violations) {
    const key = v.analyzer || 'unknown';
    if (!analyzerResults[key]) {
      analyzerResults[key] = {
        violations: [],
        status: makeVisitorStatus(totalFiles),
        executionTime,
        analyzerName: key,
      };
    }
    analyzerResults[key].violations.push(v);
  }

  // Surface languages discovered on disk but skipped (no runtime), plus any
  // subprocess errors, as diagnostics — so "Go files present, Go toolchain
  // not found" reaches the report instead of collapsing into a silent zero.
  const diagnostics: Array<{ analyzerName: string; kind: string; message: string }> = [];
  for (const na of polyglotResult.notApplicable || []) {
    diagnostics.push({ analyzerName: na.language, kind: 'notApplicable', message: na.reason });
  }
  for (const err of polyglotResult.errors || []) {
    diagnostics.push({
      analyzerName: err.language || 'polyglot',
      kind: err.type || 'error',
      message: err.message,
    });
  }

  return {
    timestamp: new Date(),
    summary: {
      totalViolations: violations.length,
      criticalIssues,
      warnings,
      suggestions,
      totalFiles,
      violationsByCategory,
      topIssues,
    },
    analyzerResults,
    recommendations: [],
    metadata: {
      auditDuration: executionTime,
      filesAnalyzed: totalFiles,
      analyzersRun: Object.keys(analyzerResults),
      fileToFunctionsMap: polyglotResult.indexEntries
        ? createFileToFunctionsMap(polyglotResult.indexEntries)
        : {},
      ...(diagnostics.length > 0 && { diagnostics }),
    },
  };
}

function createFileToFunctionsMap(indexEntries: any[]): Record<string, any[]> {
  const fileMap: Record<string, any[]> = {};
  for (const entry of indexEntries) {
    if (!fileMap[entry.file]) fileMap[entry.file] = [];
    fileMap[entry.file].push(entry);
  }
  return fileMap;
}

/**
 * Run an audit, routing to the Go subprocess when the target contains Go files
 * and to the TypeScript tree-sitter pipeline otherwise. The single place both
 * the CLI and MCP surfaces make that decision.
 */
export async function runAuditDispatch(options: AuditRunnerOptions): Promise<AuditResult> {
  // Resolve to an absolute path up front. The Go subprocess is spawned with a
  // cwd of its own (dist/languages/go), so relative file paths produced by
  // discovery (e.g. `bench/real/gin/auth.go`) would not resolve from its cwd —
  // the subprocess errors "no such file or directory" and the whole audit
  // collapses to zero findings. Absolute paths make discovery absolute, which
  // works for both the in-process TS half and the Go subprocess.
  const projectRoot = path.resolve(options.projectRoot || process.cwd());

  const hasGo = await hasFilesWithExtension(projectRoot, '.go');

  if (!hasGo) {
    const runner = createAuditRunner(options);
    return runner.run();
  }

  // Go present → the polyglot orchestrator, which runs the Go subprocess for
  // `.go` files and the node runtime for any TypeScript/JavaScript alongside.
  const runtimeManager = new RuntimeManager();
  await runtimeManager.initialize();
  const codeIndex = CodeIndexDB.getInstance();
  await codeIndex.initialize();
  const orchestrator = new LanguageOrchestrator(runtimeManager, codeIndex);

  const polyglotResult = await orchestrator.analyzePolyglotProject(projectRoot, {
    analyzers: options.enabledAnalyzers,
    minSeverity: options.minSeverity as PolyglotAnalysisOptions['minSeverity'],
    updateIndex: options.indexFunctions,
    enableCrossLanguageAnalysis: true,
    buildCrossReferences: true,
  });

  return convertPolyglotToAuditResult(polyglotResult, projectRoot);
}

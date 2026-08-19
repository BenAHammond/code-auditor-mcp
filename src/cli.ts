#!/usr/bin/env node

/**
 * Code Auditor CLI - Enhanced with AI Tool Integration
 */

// MUST be first import: sets NAPI_RS_NATIVE_LIBRARY_PATH before @ast-grep/napi loads
import './native-bootstrap.js';

import { Command } from 'commander';
import chalk from 'chalk';
import { createAuditRunner } from './auditRunner.js';
import { readFileSync } from 'fs';
import { promises as fs } from 'fs';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { DEFAULT_PORT } from './constants.js';
import inquirer from 'inquirer';
import { CodeMapGenerator } from './services/CodeMapGenerator.js';
import { initParsers } from './languages/index.js';
import { queryParser } from './search/QueryParser.js';
import { CodeIndexDB } from './codeIndexDB.js';
import type { Severity, AuditScope, SearchOptions } from './types.js';
import { getFilesProcessed, getFactsConsumed, isVisitorStatus, isReducerStatus } from './pipeline.js';
import { createBaselineFromFindings, saveBaseline, loadBaseline, diffBaselines } from './baseline.js';
import { computeDiffGatingDecision } from './enforcement/gate.js';
import { computeDiffGate } from './enforcement/diffGate.js';

// Get package.json for version info
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')
);

const program = new Command();

// Configure the main program
program
  .name('code-auditor')
  .description('TypeScript/JavaScript code quality auditor with AI tool integration')
  .version(packageJson.version);

// Legacy audit command (default behavior)
program
  .command('audit', { isDefault: true })
  .description('Run code quality audit (default command)')
  .option('-p, --path <path>', 'Path to audit', process.cwd())
  .option('-c, --config <config>', 'Configuration name')
  .option('-o, --output <dir>', 'Output directory for reports')
  .option('-f, --format <format>', 'Report format: html, json, csv, or sarif')
  .option('--fail-on <severity>', 'Exit code 2 when violations at or above this severity exist')
  .option('--full', 'Show full violation inventory (overrides default delta view when baseline exists)')
  .option('--include-baseline', 'Evaluate baseline-known violations in --fail-on checks')
  .option('--fail-on-regression', 'Exit code 2 when total advisory debt exceeds the baseline snapshot')
  .option('--preset <id>', 'Apply a shareable preset (repeatable)', (v: string, prev: string[]) => prev.concat([v]), [])
  .option('--detach', 'Run the audit in a detached background process and print the job ID')
  .option('--partition-strategy <strategy>', 'Partition strategy for detached runs: none, auto, or top-level')
  .option('--max-partitions <n>', 'Maximum number of partition shards (detached runs)')
  .option('--shard-timeout-ms <ms>', 'Per-shard timeout in milliseconds (detached runs)')
  .action(async (options) => {
    console.log(chalk.blue('🔍 Code Quality Audit Tool'));
    console.log(chalk.gray('══════════════════════════════════════════════════'));

    // Spec 41 — `--detach` hands off to a forked worker; the parent never parses
    // or hashes, so it must route out before `initParsers()`.
    if (options.detach) {
      await runDetachedAudit(options);
      return;
    }

    try {
      await initParsers();

      // Validate --fail-on severity
      const validSeverities: Severity[] = ['critical', 'warning', 'suggestion'];
      const failOnSeverity = options.failOn as Severity | undefined;
      if (failOnSeverity && !validSeverities.includes(failOnSeverity as Severity)) {
        console.error(
          chalk.red(`Invalid --fail-on severity: "${failOnSeverity}". Must be one of: ${validSeverities.join(', ')}`)
        );
        process.exit(1);
      }

      // Validate --preset ids up front (Spec 38 R4). Unknown ids are a hard
      // error, not a silent skip — same contract as print-config.
      const presetIds: string[] = Array.isArray(options.preset) ? options.preset : (options.preset ? [options.preset] : []);
      if (presetIds.length > 0) {
        const { getPreset, PRESET_IDS } = await import('./presets/presets.js');
        for (const id of presetIds) {
          if (!getPreset(id)) {
            console.error(chalk.red(`Error: unknown preset "${id}". Available: ${PRESET_IDS.join(', ')}`));
            process.exit(1);
          }
        }
      }

      const runner = createAuditRunner({
        projectRoot: options.path,
        configName: options.config,
        outputDirectory: options.output,
        presets: presetIds
      });

      const result = await runner.run();

      const violations = Object.values(result.analyzerResults).flatMap(
        (r: any) => r.violations || []
      );
      const baseline = result.metadata?.baseline;

      // ── Delta output (Spec 18 R2) ─────────────────────────────────
      if (baseline && !options.full) {
        const newViolations = violations.filter((v: any) => v.new === true);
        const knownCount = baseline.knownCount ?? 0;
        const fixedCount = baseline.fixedCount ?? 0;
        const previousKnown = baseline.previousKnownCount ?? 0;
        const currentDebt = newViolations.length + knownCount;
        const debtDelta = currentDebt - previousKnown;
        const trendIcon = debtDelta > 0 ? '↑' : debtDelta < 0 ? '↓' : '→';
        const trendLabel = debtDelta > 0
          ? `(debt increased since last baseline)`
          : debtDelta < 0
            ? `(debt decreased since last baseline)`
            : '(unchanged)';

        console.log(`\n📊 Delta: +${newViolations.length} new · −${fixedCount} fixed · ${knownCount} known  ${trendIcon} ${trendLabel}`);

        if (newViolations.length > 0) {
          console.log(chalk.gray(`\n── New Findings (${newViolations.length}) ──────────────────────────`));
          for (const v of newViolations) {
            const icon =
              v.severity === 'critical' ? '🔴' :
              v.severity === 'warning' ? '🟡' : '🔵';
            console.log(
              `${icon} ${chalk.bold(v.file)}${v.line ? `:${v.line}` : ''} [${v.severity}] ${v.message}`
            );
          }
        } else {
          console.log(chalk.green('\n✓ No new findings since last baseline.'));
        }

        // Debt by analyzer
        console.log(chalk.gray(`\n── Debt by Analyzer ──────────────────────────`));
        const analyzerCounts: Record<string, { known: number; new: number }> = {};
        for (const v of violations) {
          const a = (v as any).analyzer || 'unknown';
          if (!analyzerCounts[a]) analyzerCounts[a] = { known: 0, new: 0 };
          if ((v as any).new === false) analyzerCounts[a].known++;
          else if ((v as any).new === true) analyzerCounts[a].new++;
        }
        for (const [analyzer, counts] of Object.entries(analyzerCounts).sort()) {
          const newPart = counts.new > 0 ? ` (+${counts.new})` : '';
          console.log(`${analyzer}: ${counts.known.toLocaleString()} known${newPart}`);
        }

        // Top files
        console.log(chalk.gray(`\n── Top Files ─────────────────────────────────`));
        const fileCounts = new Map<string, number>();
        for (const v of violations) {
          const f = v.file || '';
          fileCounts.set(f, (fileCounts.get(f) || 0) + 1);
        }
        const topFiles = [...fileCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5);
        for (const [file, count] of topFiles) {
          console.log(`${file} — ${count} finding${count !== 1 ? 's' : ''}`);
        }

        console.log(chalk.gray(`\n💡 Run ${chalk.cyan('code-audit --full')} to see all ${currentDebt.toLocaleString()} findings.`));
      } else if (!baseline) {
        // No baseline: current behavior + hint
        console.log(`\nFound ${result.summary.totalViolations} violations`);
        console.log(`Critical: ${result.summary.criticalIssues}`);
        console.log(`Warnings: ${result.summary.warnings}`);
        console.log(`Suggestions: ${result.summary.suggestions}`);

        console.log(chalk.gray(`\n💡 Run ${chalk.cyan('code-audit baseline')} to adopt the ratchet and track changes over time.`));
      } else {
        // --full with baseline: full itemized inventory (current behavior)
        console.log(`\nFound ${result.summary.totalViolations} violations`);
        console.log(`Critical: ${result.summary.criticalIssues}`);
        console.log(`Warnings: ${result.summary.warnings}`);
        console.log(`Suggestions: ${result.summary.suggestions}`);
      }

      // Spec 32 — unparsed files are never silent. A run where any file failed
      // to parse (WASM abort, read error, …) must surface the count + reasons.
      const unparsedFiles = result.metadata?.unparsedFiles ?? [];
      if (unparsedFiles.length > 0) {
        console.error(chalk.red(`\n⚠️  ${unparsedFiles.length} file${unparsedFiles.length !== 1 ? 's' : ''} failed to parse:`));
        for (const u of unparsedFiles.slice(0, 20)) {
          console.error(`    ${u.filePath} — ${u.reason}`);
        }
        if (unparsedFiles.length > 20) {
          console.error(`    … and ${unparsedFiles.length - 20} more`);
        }
      }

      // Spec 36 R7 — suppressions are reported: how many exist, where, and how
      // many are unnecessary (or reasonless). Both are errors, surfaced here.
      const suppressions = result.metadata?.suppressions;
      if (suppressions) {
        console.log(chalk.gray(`\n── Suppressions ──────────────────────────────`));
        console.log(
          `  ${suppressions.total} directive${suppressions.total !== 1 ? 's' : ''}, ` +
          `${suppressions.suppressed} finding${suppressions.suppressed !== 1 ? 's' : ''} suppressed`
        );
        if (suppressions.unnecessary.length > 0) {
          console.error(chalk.red(`  ❌ ${suppressions.unnecessary.length} unnecessary (finding no longer fires):`));
          for (const d of suppressions.unnecessary) {
            console.error(`    ${d.rule} @ ${d.file}:${d.line}`);
          }
        }
        if (suppressions.reasonless.length > 0) {
          console.error(chalk.red(`  ❌ ${suppressions.reasonless.length} missing a required reason:`));
          for (const d of suppressions.reasonless) {
            console.error(`    ${d.rule} @ ${d.file}:${d.line}`);
          }
        }
      }

      // Per-analyzer activity (read from result data, not serialized summary)
      // — surfaces zero-scan failures that would otherwise be invisible.
      if (!options.json) {
        const analyzerFiles: string[] = [];
        for (const [name, ar] of Object.entries(result.analyzerResults)) {
          const vCount = ar.violations.length;
          if (isVisitorStatus(ar.status)) {
            analyzerFiles.push(`${name} [visitor-ran]: ${getFilesProcessed(ar.status)} files, ${vCount} violations`);
          } else if (isReducerStatus(ar.status)) {
            analyzerFiles.push(`${name} [reducer-ran]: ${getFactsConsumed(ar.status)} facts, ${vCount} violations`);
          } else {
            analyzerFiles.push(`${name} [notRun]: ${vCount} violations`);
          }
        }
        if (analyzerFiles.length > 0) {
          console.log(chalk.gray(`\n── Pipeline Stages ──────────────────────────`));
          console.log(analyzerFiles.join('\n'));
        }

        // ── Coverage (Spec 27) ──────────────────────────────────────────
        const coverage = result.metadata?.coverage;
        if (coverage && coverage.length > 0) {
          const fired = coverage.filter(c => c.state === 'fired');
          const clean = coverage.filter(c => c.state === 'clean');
          const unassessed = coverage.filter(c => c.state === 'unassessed');
          const notApplicable = coverage.filter(c => c.state === 'notApplicable');
          const firedCount = fired.reduce((s, c) => s + c.count, 0);

          console.log(chalk.gray(`\n── Coverage ─────────────────────────────────`));
          console.log(
            `  ${fired.length} fired (${firedCount.toLocaleString()} violations), ` +
            `${clean.length} clean, ` +
            `${unassessed.length} unassessed, ` +
            `${notApplicable.length} notApplicable ` +
            `(${coverage.length} rules registered)`
          );

          if (notApplicable.length > 0) {
            console.log(chalk.gray(`  ── Not Applicable ──`));
            for (const c of notApplicable) {
              console.log(`    ${c.ruleId}: ${c.reason ?? 'unknown'}`);
            }
          }
          if (clean.length > 0) {
            console.log(chalk.gray(`  ── Clean ──`));
            for (const c of clean) {
              console.log(`    ${c.ruleId} (0)`);
            }
          }
          if (unassessed.length > 0) {
            console.log(chalk.gray(`  ── Unassessed (zero findings, applicability unknown) ──`));
            for (const c of unassessed) {
              console.log(`    ${c.ruleId} (0)`);
            }
          }
        }
      }

      // Spec-20 R4: built-in profile visibility — silent behavior changes
      // are never acceptable. Notify when scripts-and-tests capped findings.
      const builtinCapped = Object.values(result.analyzerResults)
        .reduce((count, ar) => count + ar.violations.filter(v => v.profile === 'scripts-and-tests').length, 0);
      if (builtinCapped > 0) {
        console.log(chalk.blue(`\nℹ️  ${builtinCapped.toLocaleString()} findings capped by built-in profile "scripts-and-tests" (scripts/tests/fixtures → suggestion).`));
        console.log(chalk.gray(`   Set ${chalk.cyan('"builtin": false')} in .codeauditor.json to disable.`));
      }

      // Generate formatted report if --format is specified
      if (options.format) {
        const validFormats = ['html', 'json', 'csv', 'sarif'];
        if (!validFormats.includes(options.format)) {
          console.error(chalk.red(`Unknown format: "${options.format}". Must be one of: ${validFormats.join(', ')}`));
          process.exit(1);
        }

        const { generateReport } = await import('./reporting/reportGenerator.js');
        const report = generateReport(result, options.format as any);
        const outputDir = options.output || process.cwd();
        const ext = options.format === 'sarif' ? 'sarif' : options.format;
        const reportPath = join(outputDir, `audit-report.${ext}`);
        await fs.mkdir(dirname(reportPath), { recursive: true });
        await fs.writeFile(reportPath, report, 'utf-8');
        console.log(chalk.green(`\nReport written to ${reportPath}`));
      }

      // ── Fail-on logic (Spec 18 R3) ───────────────────────────────
      // --fail-on-regression: compare total advisory debt to baseline snapshot
      if (baseline && options.failOnRegression) {
        const currentDebt = violations.filter((v: any) => v.new || v.new === false).length;
        const snapshotDebt = baseline.previousKnownCount ?? 0;
        if (currentDebt > snapshotDebt) {
          console.error(
            chalk.red(`Debt regression: ${currentDebt - snapshotDebt} findings added without re-baselining.`)
          );
          process.exit(2);
        }
      }

      // Zero-files gate — any enabled analyzer matching zero source files is a
      // dark-analyzer failure; fail the run so the bug can't hide.
      {
        const diagnostics = result.metadata?.diagnostics ?? [];
        const zeroFileWarnings = diagnostics.filter((d: any) => d.kind === 'zero-files');
        if (zeroFileWarnings.length > 0) {
          const names = zeroFileWarnings.map((d: any) => d.analyzerName ?? d.analyzer).join(', ');
          console.error(`Zero-files failure: ${zeroFileWarnings.length} analyzer(s) matched zero source files (${names})`);
          process.exit(2);
        }
      }

      // Spec 32 — a run where any file failed to parse is incomplete and must
      // not exit 0. This mirrors the zero-files gate: a silent dark-analyzer
      // failure at file granularity is a hard failure.
      {
        const unparsedFiles = result.metadata?.unparsedFiles ?? [];
        if (unparsedFiles.length > 0) {
          console.error(`Parse-failure: ${unparsedFiles.length} file(s) could not be parsed; analysis is incomplete.`);
          process.exit(2);
        }
      }

      // --fail-on: evaluate new + invariant findings only (unless --include-baseline)
      if (failOnSeverity) {
        const evaluableViolations = (baseline && !options.includeBaseline)
          ? violations.filter((v: any) => v.new || v.analyzer === 'invariants')
          : violations;
        const severityOrder: Severity[] = ['critical', 'warning', 'suggestion'];
        const failIndex = severityOrder.indexOf(failOnSeverity);
        const hasAtOrAbove = evaluableViolations.some((v: any) => {
          const vIndex = severityOrder.indexOf(v.severity);
          return vIndex >= 0 && vIndex <= failIndex;
        });

        if (hasAtOrAbove) {
          process.exit(2);
        }
      }

    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

// Diff-scoped audit command (Spec 04 R4)
program
  .command('changed [paths...]')
  .description('Audit changed files only — reads stdin when --stdin is set')
  .option('--json', 'Output violations as machine-readable JSON to stdout')
  .option('-f, --format <format>', 'Report format: json, or sarif (overrides --json)')
  .option('--quiet', 'Suppress output when zero violations')
  .option('--fail-on-zero-files', 'Exit code 2 when any enabled analyzer matches zero source files', true)
  .option('--stdin', 'Read file paths from stdin (one per line)')
  .option('-p, --path <projectPath>', 'Project root path', process.cwd())
  .action(async (paths: string[], options: Record<string, any>) => {
    try {
      await initParsers();

      const fileSet = new Set<string>();

      // Collect paths from stdin if requested
      if (options.stdin) {
        const rl = createInterface({
          input: process.stdin,
          output: undefined as any,
          terminal: false
        });
        for await (const line of rl) {
          const trimmed = line.trim();
          if (trimmed) fileSet.add(trimmed);
        }
      }

      // Add paths from command line
      for (const p of paths) {
        fileSet.add(p);
      }

      // Resolve scope
      let scope: AuditScope = 'changed';
      if (fileSet.size > 0) {
        // Convert to absolute paths
        const resolved = [...fileSet].map((f) =>
          isAbsolute(f) ? f : resolve(process.cwd(), f)
        );
        scope = resolved as unknown as AuditScope;
      }

      // Create runner
      const runner = createAuditRunner({
        projectRoot: options.path,
        scope,
        analyzerConcurrency: 4
      });

      const result = await runner.run();

      // Collect all violations
      const violations = Object.values(result.analyzerResults).flatMap(
        (r: any) => r.violations || []
      );

      // JSON output
      if (options.format === 'sarif') {
        const { generateSARIFReport } = await import('./reporting/sarifReportGenerator.js');
        const sarifOutput = generateSARIFReport(result);
        process.stdout.write(sarifOutput + '\n');
      } else if (options.json) {
        const projectDir = resolve(options.path || process.cwd());
        const jsonOutput = violations.map((v: any) => {
          // Compute relative path if file resolves inside the project
          let filePath = v.file || '';
          if (filePath.startsWith('/') || filePath.startsWith('\\\\')) {
            const rel = relative(projectDir, filePath);
            // Only use relative path if it doesn't escape the project
            if (!rel.startsWith('..') && !isAbsolute(rel)) {
              filePath = rel;
            }
          }
          // Find column: prefer explicit column, then start.column, then default to 1
          const col = v.column ?? v.start?.column ?? 1;
          return {
            analyzer: v.analyzer || '',
            rule: v.rule || v.type || '',
            severity: v.severity,
            message: v.message,
            file: filePath,
            line: v.line ?? v.start?.line,
            column: col,
            endLine: v.end?.line,
            endColumn: v.end?.column,
            enclosingSymbol: v.symbol || v.enclosingFunction || '',
            suggestion: v.suggestion || '',
            details: v.details || '',
            ...(v.new !== undefined && { new: v.new })
          };
        });
        process.stdout.write(JSON.stringify(jsonOutput, null, 2) + '\n');
      } else if (!options.quiet || violations.length > 0) {
        // Console output — Spec 36 R3: agent-facing output emits findings,
        // never an aggregate total. The hook and the `changed` command are the
        // agent's surface; a finding total is exactly the representation the
        // consumer routes around. Findings only, each with file:line.
        console.log(chalk.blue('🔍 Diff-Scoped Code Audit'));
        console.log(chalk.gray('══════════════════════════════════════════════════'));
        console.log(chalk.gray(`Files analyzed: ${result.metadata.filesAnalyzed}`));

        if (violations.length > 0) {
          console.log(chalk.gray('\n── Violations ────────────────────────────────────'));
          for (const v of violations) {
            const icon =
              v.severity === 'critical' ? '🔴' :
              v.severity === 'warning' ? '🟡' : '🔵';
            const statusTag = (v as any).new === false
              ? chalk.dim(' [known]')
              : '';
            console.log(
              `${icon} ${chalk.bold(v.file)}${v.line ? `:${v.line}` : ''} [${v.severity}] ${v.message}${statusTag}`
            );
          }
        } else {
          console.log(chalk.green('\n✓ No findings.'));
        }
      }

      // Spec 38 R2/R3 — per-rule timing + gate wall-clock, opt-in by env var.
      // Emitted to stderr so it never corrupts --json stdout. Slowest rule first.
      if (process.env.CODE_AUDIT_RULE_TIMING === '1') {
        const ruleTiming = (result.metadata as any)?.ruleTiming as
          | Array<{ ruleId: string; totalMs: number; calls: number }>
          | undefined;
        const gateMs = (result.metadata as any)?.auditDuration as number | undefined;
        const lines: string[] = [];
        lines.push('');
        lines.push(`⏱  gate wall-clock: ${(gateMs ?? 0).toFixed(1)} ms (budget 300 ms)`);
        lines.push('── per-rule timing (slowest first) ──');
        if (ruleTiming && ruleTiming.length > 0) {
          for (const t of ruleTiming) {
            lines.push(`  ${t.ruleId.padEnd(28)} ${t.totalMs.toFixed(2).padStart(9)} ms  ×${t.calls}`);
          }
        } else {
          lines.push('  (no gating rules recorded)');
        }
        process.stderr.write(lines.join('\n') + '\n');
      }

      // Binary gate (Spec 36 R2/R4/R6): exit 2 when a gating finding is present.
      // The `changed` command is the edit-boundary gate, so it compares against
      // the file's prior state (git HEAD) via the touched-line diff gate (R2),
      // NOT against a stored baseline. Gate-excluded files and non-gating rules
      // never block. Severity does NOT factor in (R4). A gating rule that cannot
      // name a next action for an occurrence emits non-blocking and the gap is
      // recorded (R6), surfaced below to stderr.
      {
        const analyzedFiles = (result.metadata as any)?.analyzedFiles as string[] | undefined;
        // The `changed` command is always scoped, so the runner records the
        // analyzed file list. If it is somehow absent we still derive the gate
        // from the files that actually produced findings rather than falling
        // back to the baseline gate — a silent soft-fail is the one outcome R1
        // forbids.
        const gateFiles = analyzedFiles && analyzedFiles.length > 0
          ? analyzedFiles
          : [...new Set(
              (violations as any[]).map((v) => v.file).filter(Boolean)
            )];
        const diffGate = computeDiffGate(options.path, gateFiles);
        const { blocking, resolutionGaps } = computeDiffGatingDecision(violations as any, diffGate);

        if (resolutionGaps.length > 0) {
          // Spec 36 R6 — a gating rule that could not name an action is a defect
          // in the rule. Record it loudly so it cannot route around as a count.
          const lines = [
            '⚠️  resolution gap — gating rule produced no next action for these occurrences (Spec 36 R6):',
            ...resolutionGaps.map(
              (g) => `  - ${g.rule} @ ${g.file}${g.line ? `:${g.line}` : ''}`
            ),
          ];
          process.stderr.write(lines.join('\n') + '\n');
        }

        if (blocking.length > 0) {
          process.exit(2);
        }

        // Spec 36 R7 — an unnecessary or reasonless suppression is itself an
        // error. It is reported loudly and fails the write, exactly like an
        // unused `@ts-expect-error`. A suppression that outlives its finding is
        // a baseline entry with better branding unless it errors here.
        const suppressions = (result.metadata as any)?.suppressions as
          | { total: number; suppressed: number; unnecessary: any[]; reasonless: any[] }
          | undefined;
        if (suppressions && (suppressions.unnecessary.length > 0 || suppressions.reasonless.length > 0)) {
          const lines: string[] = [];
          if (suppressions.reasonless.length > 0) {
            lines.push('❌ suppression missing a required reason (Spec 36 R7):');
            for (const d of suppressions.reasonless) {
              lines.push(`  - ${d.rule} @ ${d.file}:${d.line}`);
            }
          }
          if (suppressions.unnecessary.length > 0) {
            lines.push('❌ unnecessary suppression — the finding no longer fires (Spec 36 R7):');
            for (const d of suppressions.unnecessary) {
              lines.push(`  - ${d.rule} @ ${d.file}:${d.line}`);
            }
          }
          process.stderr.write(lines.join('\n') + '\n');
          process.exit(2);
        }
      }

      // Exit code based on --no-fail-on-zero-files (default-on in v3.4.8)
      // Any enabled analyzer matching zero source files is a failure — a >50%
      // threshold lets the exact bug (3/9 analyzers dark) pass silently.
      if (options.failOnZeroFiles !== false) {
        const diagnostics = result.metadata?.diagnostics ?? [];
        const zeroFileWarnings = diagnostics.filter((d: any) => d.kind === 'zero-files');
        if (zeroFileWarnings.length > 0) {
          const names = zeroFileWarnings.map((d: any) => d.analyzer).join(', ');
          console.error(`Zero-files failure: ${zeroFileWarnings.length} analyzer(s) matched zero source files (${names})`);
          process.exit(2);
        }
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

// Baseline command (Spec 18 R1)
program
  .command('baseline')
  .description('Snapshot current advisory findings as the baseline (excludes invariants)')
  .option('-p, --path <path>', 'Project path', process.cwd())
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      await initParsers();

      const runner = createAuditRunner({
        projectRoot: options.path,
      });

      const result = await runner.run();

      // Collect all violations from analyzer results
      const allViolations = Object.values(result.analyzerResults).flatMap(
        (r: any) => r.violations || []
      );

      // Compute corpus stats
      const corpusStats = {
        files: result.metadata.filesAnalyzed,
        functions: result.metadata.collectedFunctions?.length ?? 0,
      };

      // Build per-analyzer counts
      const analyzerCounts: Record<string, number> = {};
      for (const v of allViolations) {
        if (v.analyzer === 'invariants') continue;
        const a = v.analyzer || 'unknown';
        analyzerCounts[a] = (analyzerCounts[a] || 0) + 1;
      }

      // Create new baseline
      const newBaseline = createBaselineFromFindings(allViolations, {
        toolVersion: packageJson.version,
        totalFindings: allViolations.filter((v) => v.analyzer !== 'invariants').length,
        analyzerCounts,
        corpusStats,
      });

      // Load existing baseline for diff
      const projectRoot = resolve(options.path || process.cwd());
      const existing = loadBaseline(projectRoot);
      const diff = existing ? diffBaselines(existing, newBaseline) : null;

      // Save
      saveBaseline(projectRoot, newBaseline);

      if (options.json) {
        process.stdout.write(JSON.stringify({
          success: true,
          absorbed: diff?.absorbed ?? newBaseline.entries.length,
          fixed: diff?.fixed ?? 0,
          totalKnown: newBaseline.entries.length,
          invariantsExcluded: allViolations.filter((v: any) => v.analyzer === 'invariants').length,
        }, null, 2) + '\n');
      } else {
        const absorbed = diff?.absorbed ?? newBaseline.entries.length;
        const fixed = diff?.fixed ?? 0;
        const totalKnown = newBaseline.entries.length;
        console.log(chalk.green(`\n✓ Baseline updated: ${absorbed} finding${absorbed !== 1 ? 's' : ''} absorbed, ${fixed} fixed, ${totalKnown} total known.`));
        console.log(chalk.gray('Invariants excluded (they always enforce).'));
        if (totalKnown > 0) {
          console.log(chalk.gray(`\nRun ${chalk.cyan('code-audit')} to see your delta view.`));
        }
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

// Generate configuration command
program
  .command('generate-config')
  .alias('gen')
  .description('Generate a .codeauditor.json scaffold with invariant rules')
  .option('-o, --output <dir>', 'Output directory', '.')
  .option('-i, --interactive', 'Interactive rule builder')
  .option('-f, --force', 'Force overwrite existing file without confirmation')
  .option('-y, --yes', 'Skip confirmation prompts (same as --force)')
  .action(async (options) => {
    console.log(chalk.blue('🛠️  Code Auditor Config Generator'));
    console.log(chalk.gray('════════════════════════════════════════════════════'));
    
    try {
      await generateConfigurations(options);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

// Start server command (placeholder - will be implemented later)
program
  .command('start')
  .description('Start the MCP server')
  .option('-p, --port <port>', 'Server port', String(DEFAULT_PORT))
  .option('-m, --mcp-mode', 'Start in MCP stdio mode')
  .option('-r, --rest-api', 'Enable REST API endpoints')
  .option('-i, --index <path>', 'Path to index on startup')
  .action(async (options) => {
    console.log(chalk.yellow('Server start will be implemented in a future task'));
    console.log('Options:', options);
    // TODO: Implement server start
  });

// Index command
const indexCmd = program
  .command('index')
  .description('Manage the code index')
  .action(() => {
    console.log(chalk.yellow('Use an index subcommand:'));
    console.log(chalk.gray('  code-audit index sync --path .     Sync the index from source files'));
    console.log(chalk.gray('  code-audit index cleanup            Remove stale entries for deleted files'));
    console.log(chalk.gray('  code-audit index reset              Clear all analysis data'));
  });

indexCmd
  .command('sync')
  .description('Synchronize index from source files')
  .option('--path <path>', 'Path to a specific file or directory', process.cwd())
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      await initParsers();
      const targetPath = resolve(options.path || process.cwd());
      const isSingleFile = (await fs.stat(targetPath).catch(() => null))?.isFile();
      const projectRoot = isSingleFile ? dirname(targetPath) : targetPath;
      const db = CodeIndexDB.getInstance(undefined, projectRoot);
      await db.initialize();
      let result: any;

      if (isSingleFile) {
        result = await db.synchronizeFile(targetPath);
        result = { mode: 'sync', success: true, path: targetPath, ...(result || { message: 'File not found' }) };
      } else {
        const syncResult = await db.deepSync(targetPath);
        result = {
          mode: 'sync',
          success: true,
          syncedFiles: syncResult.syncedFiles,
          addedFunctions: syncResult.addedFunctions,
          updatedFunctions: syncResult.updatedFunctions,
          removedFunctions: syncResult.removedFunctions,
          errors: syncResult.errors,
          message: `Synced ${syncResult.syncedFiles} files: ${syncResult.addedFunctions} added, ${syncResult.updatedFunctions} updated, ${syncResult.removedFunctions} removed`,
        };
      }

      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        console.log(chalk.green(result.success ? '✓ Index sync complete' : '✗ Index sync failed'));
        if (result.message) console.log(chalk.gray(result.message));
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

indexCmd
  .command('cleanup')
  .description('Remove index entries for deleted files')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const db = CodeIndexDB.getInstance();
      await db.initialize();
      const result = await db.bulkCleanup();
      if (options.json) {
        process.stdout.write(JSON.stringify({ mode: 'cleanup', success: true, ...result }) + '\n');
      } else {
        console.log(chalk.green('✓ Cleanup complete'));
        console.log(chalk.gray(`Removed ${result.removedCount} entries from ${result.removedFiles.length} deleted files`));
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

indexCmd
  .command('reset')
  .description('Clear all analysis data (preserves tasks, config, whitelist)')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const db = CodeIndexDB.getInstance();
      await db.initialize();
      await db.clearIndex();
      if (options.json) {
        process.stdout.write(JSON.stringify({ mode: 'reset', success: true, message: 'All analysis data cleared' }) + '\n');
      } else {
        console.log(chalk.green('✓ Index reset complete'));
        console.log(chalk.gray('All analysis-derived data cleared (tasks, config, and whitelist preserved)'));
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

// ── Index status command (Spec 14 R1) ──────────────────────────
indexCmd
  .command('status')
  .description('Show index health and graph statistics')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const db = CodeIndexDB.getInstance();
      await db.initialize();
      const stats = await db.getStats();

      // Graph stats — non-fatal if graph cache is empty
      let graphStats: import('./types.js').GraphStats | null = null;
      try {
        graphStats = db.getGraphStats();
      } catch {
        // No graph data yet — ok
      }

      if (options.json) {
        process.stdout.write(JSON.stringify({
          totalFunctions: stats.totalFunctions,
          totalFiles: stats.filesIndexed,
          languageBreakdown: stats.languages,
          graphStats: graphStats ? {
            callNodes: graphStats.callNodes,
            callEdges: graphStats.callEdges,
            unresolvedCalls: graphStats.unresolvedCalls,
            unresolvedShare: graphStats.unresolvedShare,
            importNodes: graphStats.importNodes,
            importEdges: graphStats.importEdges,
          } : null,
        }, null, 2) + '\n');
      } else {
        console.log(chalk.blue('📊 Index Status'));
        console.log(chalk.gray('══════════════════════════════════'));
        console.log(`${chalk.bold('Total functions:')} ${(stats.totalFunctions ?? 0).toLocaleString()}`);
        console.log(`${chalk.bold('Total files:')} ${(stats.filesIndexed ?? 0).toLocaleString()}`);
        if (stats.languages && Object.keys(stats.languages).length > 0) {
          console.log(chalk.bold('\nLanguage breakdown:'));
          for (const [lang, count] of Object.entries(stats.languages)) {
            console.log(`  ${lang}: ${(count as number).toLocaleString()}`);
          }
        }

        if (graphStats) {
          console.log(chalk.bold('\nCall Graph:'));
          console.log(`  ${chalk.bold('Nodes:')} ${graphStats.callNodes.toLocaleString()}`);
          console.log(`  ${chalk.bold('Edges:')} ${graphStats.callEdges.toLocaleString()}`);
          const pct = (graphStats.unresolvedShare * 100).toFixed(1);
          if (graphStats.unresolvedShare > 0.3) {
            console.log(`  ${chalk.yellow(`⚠ Unresolved: ${graphStats.unresolvedCalls.toLocaleString()} (${pct}%) — graph metrics may be incomplete`)}`);
          } else {
            console.log(`  ${chalk.bold('Unresolved:')} ${graphStats.unresolvedCalls.toLocaleString()} (${pct}%)`);
          }
          console.log(chalk.bold('\nImport Graph:'));
          console.log(`  ${chalk.bold('Nodes:')} ${graphStats.importNodes.toLocaleString()}`);
          console.log(`  ${chalk.bold('Edges:')} ${graphStats.importEdges.toLocaleString()}`);
        } else {
          console.log(chalk.gray('\nNo graph data available. Run a full sync (code-audit index sync) first.'));
        }
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

// Config command
const configCmd = program
  .command('config')
  .description('Manage analyzer configuration and invariant rules')
  .action(() => {
    console.log(chalk.yellow('Use a config subcommand:'));
    console.log(chalk.gray('  code-audit config rules-list       List invariant rules from .codeauditor.json'));
    console.log(chalk.gray('  code-audit config rules-check      Validate .codeauditor.json rules'));
    console.log(chalk.gray('  code-audit config profiles         Show active path profiles'));
    console.log(chalk.gray('  code-audit config detection        Show DB/validator provenance and inferred receivers'));
  });

configCmd
  .command('rules-list')
  .description('List all configured invariant rules from .codeauditor.json')
  .option('--config-path <path>', 'Path to .codeauditor.json')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const pathModule = await import('path');
      const { readFileSync } = await import('fs');
      const configPath = options.configPath ||
        pathModule.join(process.cwd(), '.codeauditor.json');
      try {
        const raw = readFileSync(configPath, 'utf-8');
        const config = JSON.parse(raw);
        const rules = config?.rules ?? [];
        if (options.json) {
          process.stdout.write(JSON.stringify({
            rules: rules.map((r: any) => ({ id: r.id, kind: r.kind, severity: r.severity, message: r.message || null })),
            count: rules.length,
            configPath,
          }, null, 2) + '\n');
        } else {
          if (rules.length === 0) {
            console.log(chalk.yellow(`No rules found in ${configPath}`));
          } else {
            console.log(chalk.blue(`\n${rules.length} rule(s) in ${configPath}`));
            console.log(chalk.gray('──────────────────────────────────────────'));
            for (const r of rules) {
              const sevIcon = r.severity === 'critical' ? '🔴' : r.severity === 'warning' ? '🟡' : '🔵';
              console.log(`${sevIcon} ${chalk.bold(r.id)}  [${r.kind}] ${chalk.dim(r.severity)}`);
              if (r.message) console.log(`   ${r.message}`);
            }
          }
        }
      } catch (err: any) {
        console.error(chalk.red(`Failed to read rules: ${err.message}`));
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

configCmd
  .command('rules-check')
  .description('Validate the current .codeauditor.json rules')
  .option('--config-path <path>', 'Path to .codeauditor.json')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const pathModule = await import('path');
      const { readFileSync } = await import('fs');
      const { validateRulesConfig } = await import('./invariants/ruleValidator.js');
      const configPath = options.configPath ||
        pathModule.join(process.cwd(), '.codeauditor.json');
      try {
        const raw = readFileSync(configPath, 'utf-8');
        const config = JSON.parse(raw);
        const rulesArray = config?.rules;
        const errors = validateRulesConfig({ rules: rulesArray ?? [] });
        if (options.json) {
          process.stdout.write(JSON.stringify({
            valid: errors.length === 0,
            errors: errors.map(e => ({ ruleId: e.ruleId || null, message: e.message })),
            configPath,
          }, null, 2) + '\n');
        } else {
          if (errors.length === 0) {
            console.log(chalk.green(`✓ All rules valid (${configPath})`));
          } else {
            console.log(chalk.red(`✗ ${errors.length} validation error(s) in ${configPath}`));
            console.log(chalk.gray('──────────────────────────────────────────'));
            for (const e of errors) {
              const id = e.ruleId ? chalk.bold(e.ruleId) + ': ' : '';
              console.log(`  ${id}${chalk.red(e.message)}`);
            }
          }
        }
      } catch (err: any) {
        console.error(chalk.red(`Failed to read/parse config: ${err.message}`));
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

// Config profiles subcommand — debug surface for path profiles (Spec-20 R5)
configCmd
  .command('profiles')
  .description('Show active path profiles and resolve per-file matching')
  .option('-p, --path <path>', 'Project path', process.cwd())
  .option('--file <file>', 'Resolve profiles for a specific file')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const fs = await import('fs/promises');
      const pathModule = await import('path');
      const { loadConfig } = await import('./config/configLoader.js');
      const { resolvePathProfile } = await import('./config/pathProfiles.js');

      const projectRoot = pathModule.resolve(options.path);
      const configPath = pathModule.join(projectRoot, '.codeauditor.json');

      let profiles: { name: string; paths: string[]; overrides: Record<string, unknown>; builtin?: boolean }[] = [];

      try {
        await fs.access(configPath);
        const config = await loadConfig({ configPath });
        profiles = config.pathProfiles || [];
      } catch {
        // No config file — use defaults only
        const { mergePathProfiles } = await import('./config/defaults.js');
        profiles = mergePathProfiles(undefined, undefined) || [];
      }

      if (options.file) {
        // Resolve profiles for a specific file
        const filePath = pathModule.resolve(options.file);
        const resolved = resolvePathProfile(filePath, projectRoot, profiles);

        if (options.json) {
          process.stdout.write(JSON.stringify({
            file: options.file,
            resolvedFilePath: filePath,
            matchedProfileNames: resolved.matchedProfileNames,
            excludeFromGate: resolved.excludeFromGate || null,
            overrides: resolved.overrides,
          }, null, 2) + '\n');
        } else {
          if (resolved.matchedProfileNames.length === 0) {
            console.log(chalk.gray(`No profiles match: ${options.file}`));
          } else {
            console.log(chalk.bold(`Profiles matching: ${options.file}`));
            for (const name of resolved.matchedProfileNames) {
              const profile = profiles.find(p => p.name === name);
              const builtinTag = profile?.builtin !== false && profiles.some(p => p.name === name) ? '' : '';
              console.log(`  ${chalk.cyan(name)}${builtinTag ? chalk.gray(' (built-in)') : ''}`);
            }
            if (resolved.excludeFromGate) {
              console.log(chalk.yellow(`  excludeFromGate: true`));
            }
            if (Object.keys(resolved.overrides).length > 0) {
              console.log(chalk.gray('  merged overrides:'));
              for (const [key, value] of Object.entries(resolved.overrides)) {
                console.log(chalk.gray(`    ${key}: ${JSON.stringify(value)}`));
              }
            }
          }
        }
      } else {
        // List all active profiles
        if (options.json) {
          process.stdout.write(JSON.stringify({
            projectRoot,
            profiles: profiles.map(p => ({
              name: p.name,
              paths: p.paths,
              overrides: p.overrides,
              builtin: p.builtin !== false,
            })),
          }, null, 2) + '\n');
        } else {
          if (profiles.length === 0) {
            console.log(chalk.gray('No path profiles active.'));
          } else {
            console.log(chalk.bold('Active path profiles:'));
            for (const p of profiles) {
              const tag = p.builtin !== false ? chalk.gray(' [built-in]') : '';
              console.log(`  ${chalk.cyan(p.name)}${tag}`);
              console.log(chalk.gray(`    paths: ${p.paths.join(', ')}`));
              if (p.overrides && Object.keys(p.overrides).length > 0) {
                for (const [key, value] of Object.entries(p.overrides)) {
                  console.log(chalk.gray(`    ${key}: ${JSON.stringify(value)}`));
                }
              }
            }
          }
        }
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

// Config detection subcommand — provenance debug surface (Spec-21 R2)
configCmd
  .command('detection')
  .description('Show DB-provenanced and inferred receiver identifiers with per-entry evidence')
  .option('-p, --path <path>', 'Project path', process.cwd())
  .option('--json', 'Output as JSON')
  .option('--mode <mode>', 'Detection mode filter (hybrid, provenance, names)')
  .action(async (options) => {
    try {
      const pathModule = await import('path');
      const fsPromises = await import('fs/promises');
      const { initParsers } = await import('./languages/tree-sitter/parser.js');
      const { initializeLanguages } = await import('./languages/index.js');
      const { LanguageRegistry } = await import('./languages/LanguageRegistry.js');
      const { loadConfig } = await import('./config/configLoader.js');
      const provenanceMod = await import('./analyzers/provenance.js');
      const {
        buildProvenanceContext,
        inferReceivers,
      } = provenanceMod;

      initializeLanguages();
      await initParsers();
      const registry = LanguageRegistry.getInstance();
      const projectRoot = pathModule.resolve(options.path);

      // Load config to get detection mode and analyzer settings
      let config: any = {};
      try {
        const configPath = pathModule.join(projectRoot, '.codeauditor.json');
        await fsPromises.access(configPath);
        config = await loadConfig({ configPath });
      } catch {
        // No config — use defaults
      }

      const detectionMode = options.mode ||
        config?.analyzerOptions?.schema?.detection?.mode ||
        config?.analyzerOptions?.['data-access']?.detection?.mode ||
        'hybrid';

      // Gather files
      const { findFiles } = await import('./utils/fileDiscovery.js');
      const files = await findFiles(projectRoot);

      const provenanced: Array<{
        identifier: string;
        file: string;
        reason: string;
        source: string;
        chain?: string[];
      }> = [];

      const validatorIdentifiers: Array<{
        identifier: string;
        file: string;
        reason: string;
        source: string;
        chain?: string[];
      }> = [];

      const inferred: Array<{
        identifier: string;
        file: string;
        reason: string;
      }> = [];

      // Per-file scan
      for (const filePath of files.slice(0, 500)) {
        const relPath = pathModule.relative(projectRoot, filePath);
        const adapter = registry.getAdapterForFile(filePath);
        if (!adapter) continue;

        try {
          const sourceCode = await fsPromises.readFile(filePath, 'utf-8');
          const ast = await adapter.parse(filePath, sourceCode);
          if (!ast?.root) continue;

          const schemaCfg = config?.analyzerOptions?.schema ?? {};
          const daCfg = config?.analyzerOptions?.['data-access'] ?? {};

          // Build provenance context using schema analyzer config (most complete)
          const ctx = buildProvenanceContext(ast, adapter, sourceCode, {
            mode: detectionMode as any,
            dbReceiverNames: schemaCfg.dbReceiverNames ?? daCfg.dbReceiverNames,
            dbBindingNames: schemaCfg.dbBindingNames ?? daCfg.dbBindingNames,
            dbCallMethods: schemaCfg.dbCallMethods ?? daCfg.dbCallMethods,
          });

          // Collect DB-provenanced
          for (const [id, evidence] of ctx.dbProvenanced) {
            provenanced.push({
              identifier: id,
              file: relPath,
              reason: evidence.reason,
              source: evidence.source,
              chain: evidence.chain.length > 0 ? evidence.chain : undefined,
            });
          }

          // Collect validator-provenanced
          for (const [id, evidence] of ctx.validatorProvenanced) {
            validatorIdentifiers.push({
              identifier: id,
              file: relPath,
              reason: evidence.reason,
              source: evidence.source,
              chain: evidence.chain.length > 0 ? evidence.chain : undefined,
            });
          }

          // Run inference
          if (ctx.dbProvenanced.size > 0) {
            const inf = inferReceivers(ctx.dbProvenanced, ast, adapter, sourceCode);
            for (const ev of inf.evidence) {
              inferred.push({
                identifier: ev.identifier,
                file: relPath,
                reason: ev.reason,
              });
            }
          }
        } catch {
          // Skip unparseable files
        }
      }

      // Persist provenance to code index for cross-file consumption (Spec-21 R2)
      try {
        const db = CodeIndexDB.getInstance();
        await db.initialize();

        // Store per-file provenance
        const byFile = new Map<string, { dbProvenanced: typeof provenanced; validatorProvenanced: typeof validatorIdentifiers }>();
        for (const p of provenanced) {
          const entry = byFile.get(p.file) || (byFile.set(p.file, { dbProvenanced: [], validatorProvenanced: [] }), byFile.get(p.file)!);
          entry.dbProvenanced.push(p);
        }
        for (const v of validatorIdentifiers) {
          const entry = byFile.get(v.file) || (byFile.set(v.file, { dbProvenanced: [], validatorProvenanced: [] }), byFile.get(v.file)!);
          entry.validatorProvenanced.push(v);
        }
        for (const [file, data] of byFile) {
          db.storeFileProvenance(file, data);
        }

        // Store inferred receivers
        db.storeInferredReceivers(inferred);
      } catch {
        // Index not available — skip persistence
      }

      if (options.json) {
        process.stdout.write(JSON.stringify({
          mode: detectionMode,
          projectRoot,
          filesScanned: files.slice(0, 500).length,
          dbProvenanced: provenanced,
          validatorProvenanced: validatorIdentifiers,
          inferred,
        }, null, 2) + '\n');
      } else {
        console.log(chalk.bold(`Detection mode: ${chalk.cyan(detectionMode)}`));
        console.log(chalk.gray(`Scanned ${files.slice(0, 500).length} files`));
        console.log();

        if (provenanced.length > 0) {
          console.log(chalk.bold('DB-Provenanced Identifiers:'));
          for (const p of provenanced) {
            const reasonColor = p.reason === 'fallback'
              ? chalk.yellow
              : p.reason === 'package'
                ? chalk.green
                : chalk.cyan;
            console.log(`  ${chalk.white(p.identifier)} ${chalk.gray(`(${p.file})`)}`);
            console.log(`    ${reasonColor(`reason: ${p.reason}`)} — ${chalk.gray(p.source)}`);
            if (p.chain) {
              console.log(`    ${chalk.gray(`chain: ${p.chain.join(' → ')}`)}`);
            }
          }
          console.log();
        }

        if (inferred.length > 0) {
          console.log(chalk.bold('Inferred Receivers:'));
          for (const i of inferred) {
            console.log(`  ${chalk.white(i.identifier)} ${chalk.gray(`(${i.file})`)}`);
            console.log(`    ${chalk.magenta(i.reason)}`);
          }
          console.log();
        }

        if (validatorIdentifiers.length > 0) {
          console.log(chalk.bold('Validator-Provenanced Identifiers:'));
          for (const v of validatorIdentifiers) {
            console.log(`  ${chalk.white(v.identifier)} ${chalk.gray(`(${v.file})`)}`);
            console.log(`    ${chalk.green(`reason: ${v.reason}`)} — ${chalk.gray(v.source)}`);
          }
          console.log();
        }

        if (provenanced.length === 0 && inferred.length === 0 && validatorIdentifiers.length === 0) {
          console.log(chalk.gray('No DB-provenanced, inferred, or validator-provenanced identifiers found.'));
        }
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

// Search command
program
  .command('search <query>')
  .description('Search the code index with operator syntax: calls:<fn>, dep:<module>, lang:<lang>, complexity:>N, etc.')
  .option('-l, --limit <limit>', 'Result limit', '20')
  .option('--language <lang>', 'Filter by language (typescript, javascript, go)')
  .option('--json', 'Output results as JSON')
  .option('--definition', 'Look up a specific symbol definition by name')
  .action(async (query, options) => {
    try {
      await initParsers();
      await runSearch(query, options);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

// Test command (placeholder - will be implemented later)
program
  .command('test <tool>')
  .description('Test connection to AI tool')
  .action(async (tool) => {
    console.log(chalk.yellow('Test command will be implemented in a future task'));
    console.log('Tool:', tool);
    // TODO: Implement connection testing
  });

// Code map command
program
  .command('map')
  .alias('codemap')
  .description('Generate a human-readable map of the codebase')
  .option('-p, --path <path>', 'Project path to map', process.cwd())
  .option('--no-complexity', 'Exclude complexity metrics')
  .option('--no-documentation', 'Exclude documentation analysis') 
  .option('--no-dependencies', 'Exclude dependency information')
  .option('--include-usage', 'Include function usage and call information')
  .option('--no-group-by-directory', 'Don\'t group files by directory')
  .option('--max-depth <depth>', 'Maximum files to show per directory', '10')
  .option('--no-unused-imports', 'Hide unused import warnings')
  .option('--min-complexity <threshold>', 'Minimum complexity threshold for warnings', '7')
  .option('-o, --output <file>', 'Save output to file instead of displaying')
  .action(async (options) => {
    console.log(chalk.blue('🗺️  Codebase Map Generator'));
    console.log(chalk.gray('════════════════════════════════════════════════════'));
    
    try {
      await generateCodeMap(options);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

// Tasks command — thin adapter over MCP service layer
const tasksCmd = program
  .command('tasks')
  .description('Manage the per-project task queue')
  .action(() => {
    console.log(chalk.yellow('Use a tasks subcommand: list, create, get, update, complete, delete, from-audit'));
    console.log(chalk.gray('  code-audit tasks list              List all tasks'));
    console.log(chalk.gray('  code-audit tasks create --title "Fix SQL injection"'));
    console.log(chalk.gray('  code-audit tasks get <taskId>      Get task details'));
    console.log(chalk.gray('  code-audit tasks update <taskId> --status in_progress'));
    console.log(chalk.gray('  code-audit tasks complete <taskId>  Mark task done'));
    console.log(chalk.gray('  code-audit tasks delete <taskId>    Delete a task'));
    console.log(chalk.gray('  code-audit tasks from-audit         Create tasks from audit violations'));
  });

tasksCmd
  .command('list')
  .description('List project tasks')
  .option('--status <status>', 'Filter by status (open, in_progress, completed)')
  .option('--source <source>', 'Filter by source (manual, audit)')
  .option('--priority <priority>', 'Filter by priority (low, medium, high)')
  .option('--label <label>', 'Filter by label')
  .option('--limit <limit>', 'Result limit', '50')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const args: Record<string, unknown> = { action: 'list' };
      if (options.status) args.status = options.status;
      if (options.source) args.source = options.source;
      if (options.priority) args.priority = options.priority;
      if (options.label) args.label = options.label;
      if (options.limit) args.limit = parseInt(options.limit, 10);

      const { handleProjectTasks } = await import('./mcp-tools/projectTasks.js');
      const result = await handleProjectTasks(args);

      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else if (result.success) {
        const tasks = (result as any).tasks || [];
        if (tasks.length === 0) {
          console.log(chalk.yellow('No tasks found.'));
        } else {
          for (const t of tasks) {
            const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '📋';
            const priority = t.priority ? chalk.dim(` [${t.priority}]`) : '';
            console.log(`${icon} ${chalk.bold(t.title ?? t.id)}${priority}`);
            if (t.description) console.log(chalk.dim(`   ${t.description}`));
          }
        }
      } else {
        console.error(chalk.red(result.error || 'Unknown error'));
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

tasksCmd
  .command('create')
  .description('Create a project task')
  .requiredOption('--title <title>', 'Task title')
  .option('--description <description>', 'Task description')
  .option('--priority <priority>', 'Priority (low, medium, high)')
  .option('--status <status>', 'Status (open, in_progress)')
  .option('--labels <labels>', 'Comma-separated labels')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const args: Record<string, unknown> = {
        action: 'create',
        title: options.title,
      };
      if (options.description) args.description = options.description;
      if (options.priority) args.priority = options.priority;
      if (options.status) args.status = options.status;
      if (options.labels) args.labels = options.labels.split(',').map((s: string) => s.trim());

      const { handleProjectTasks } = await import('./mcp-tools/projectTasks.js');
      const result = await handleProjectTasks(args);

      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else if (result.success) {
        const task = (result as any).task || {};
        console.log(chalk.green(`✓ Task created: ${task.title || task.taskId || 'unknown'}`));
      } else {
        console.error(chalk.red(result.error || 'Unknown error'));
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

tasksCmd
  .command('get <taskId>')
  .description('Get a task by ID')
  .option('--json', 'Output as JSON')
  .action(async (taskId, options) => {
    try {
      const { handleProjectTasks } = await import('./mcp-tools/projectTasks.js');
      const result = await handleProjectTasks({ action: 'get', taskId });

      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else if (result.success) {
        const t = (result as any).task;
        console.log(chalk.blue(`\nTask: ${t.title}`));
        console.log(chalk.gray('──────────────────────────────────────────'));
        console.log(`${chalk.bold('ID:')} ${t.id}`);
        console.log(`${chalk.bold('Status:')} ${t.status}`);
        if (t.priority) console.log(`${chalk.bold('Priority:')} ${t.priority}`);
        if (t.description) console.log(`${chalk.bold('Description:')}\n${t.description}`);
        if (t.labels?.length) console.log(`${chalk.bold('Labels:')} ${t.labels.join(', ')}`);
        if (t.relatedFiles?.length) console.log(`${chalk.bold('Files:')} ${t.relatedFiles.join(', ')}`);
        if (t.fingerprint) console.log(chalk.dim(`\nfingerprint: ${t.fingerprint}`));
      } else {
        console.error(chalk.red(result.error || 'Unknown error'));
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

tasksCmd
  .command('update <taskId>')
  .description('Update a task')
  .option('--title <title>', 'New title')
  .option('--description <description>', 'New description')
  .option('--status <status>', 'New status (open, in_progress, completed)')
  .option('--priority <priority>', 'New priority (low, medium, high)')
  .option('--labels <labels>', 'Comma-separated labels')
  .option('--json', 'Output as JSON')
  .action(async (taskId, options) => {
    try {
      const patch: Record<string, unknown> = {};
      if (options.title) patch.title = options.title;
      if (options.description) patch.description = options.description;
      if (options.status) patch.status = options.status;
      if (options.priority) patch.priority = options.priority;
      if (options.labels) patch.labels = options.labels.split(',').map((s: string) => s.trim());

      if (Object.keys(patch).length === 0) {
        console.error(chalk.yellow('No update fields provided. Use --title, --description, --status, --priority, or --labels.'));
        process.exit(1);
      }

      const { handleProjectTasks } = await import('./mcp-tools/projectTasks.js');
      const result = await handleProjectTasks({ action: 'update', taskId, patch });

      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else if (result.success) {
        console.log(chalk.green(`✓ Task updated`));
      } else {
        console.error(chalk.red(result.error || 'Unknown error'));
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

tasksCmd
  .command('complete <taskId>')
  .description('Mark a task as completed')
  .option('--json', 'Output as JSON')
  .action(async (taskId, options) => {
    try {
      const { handleProjectTasks } = await import('./mcp-tools/projectTasks.js');
      const result = await handleProjectTasks({ action: 'complete_task', taskId });

      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else if (result.success) {
        console.log(chalk.green(`✓ Task completed`));
      } else {
        console.error(chalk.red(result.error || 'Unknown error'));
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

tasksCmd
  .command('delete <taskId>')
  .description('Delete a task')
  .option('--json', 'Output as JSON')
  .action(async (taskId, options) => {
    try {
      const { handleProjectTasks } = await import('./mcp-tools/projectTasks.js');
      const result = await handleProjectTasks({ action: 'delete', taskId });

      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else if (result.success) {
        console.log(chalk.green(`✓ Task deleted`));
      } else {
        console.error(chalk.red(result.error || 'Unknown error'));
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

tasksCmd
  .command('from-audit')
  .description('Populate tasks from audit violations')
  .option('--auditJobId <id>', 'Specific audit result ID')
  .option('--severities <severities>', 'Comma-separated severities (critical,warning,suggestion)', 'critical,warning')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const args: Record<string, unknown> = { action: 'from_audit' };
      if (options.auditJobId) args.auditJobId = options.auditJobId;
      if (options.severities) args.severities = options.severities.split(',').map((s: string) => s.trim());

      const { handleProjectTasks } = await import('./mcp-tools/projectTasks.js');
      const result = await handleProjectTasks(args);

      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else if (result.success) {
        const r = result as any;
        console.log(chalk.green(`✓ Created ${r.created || 0} task(s), skipped ${r.skipped || 0} (duplicates)`));
        if (r.tasks?.length) {
          for (const t of r.tasks) {
            console.log(`  📋 ${chalk.bold(t.title)}`);
          }
        }
      } else if (result.error === 'No audit results found. Run an audit first, or provide an auditJobId.') {
        // Not a real error — just nothing to convert. Exit 0 so scripts don't break.
        console.log(chalk.yellow(result.error));
      } else {
        console.error(chalk.red(result.error || 'Unknown error'));
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

// ── Ledger command — Spec 11 R1 ──────────────────────────────────────────
// ── Hotspots command (Spec 13 R2/R3) ─────────────────────────────────────────

program
  .command('hotspots')
  .description('Rank files and functions by hotspot score (churn × complexity)')
  .option('--limit <n>', 'Max entries to show')
  .option('--path <dir>', 'Target directory (triggers spot churn extraction if index is empty)')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const db = CodeIndexDB.getInstance();
      await db.initialize();
      const rawDb = db.rawDb;

      // Trigger a fast churn extraction if no hotspot scores exist yet
      const existing = rawDb.prepare('SELECT COUNT(*) AS cnt FROM hotspot_scores').get() as any;
      if (existing.cnt === 0 && options.path) {
        const { extractChurn } = await import('./churn/churnExtractor.js');
        const { computeHotspots } = await import('./hotspots/hotspotScorer.js');
        try {
          extractChurn(rawDb, options.path, { churnWindowMonths: 12 });
          computeHotspots(rawDb);
        } catch (err) {
          // Graceful: no git repo or extraction failure.
          // Warn so the agent/user knows hotspots are unavailable.
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[code-audit] On-demand churn extraction failed: ${message}`);
        }
      }

      const rows = rawDb.prepare(`
        SELECT target, type, score, churn_pct, complexity_pct, commit_count,
               distinct_authors, dominant_author, dominant_author_share,
               bus_factor_risk, complexity
        FROM hotspot_scores
        ORDER BY score DESC
        ${options.limit ? 'LIMIT ?' : ''}
      `).all(...(options.limit ? [parseInt(options.limit, 10)] : [])) as any[];

      if (options.json) {
        const entries = rows.map((r: any) => ({
          target: r.target,
          type: r.type,
          score: Math.round(r.score * 1000) / 1000,
          churnPercentile: Math.round(r.churn_pct * 1000) / 1000,
          complexityPercentile: Math.round(r.complexity_pct * 1000) / 1000,
          commitCount: r.commit_count,
          distinctAuthors: r.distinct_authors,
          dominantAuthor: r.dominant_author,
          dominantAuthorShare: Math.round((r.dominant_author_share ?? 0) * 1000) / 1000,
          busFactorRisk: !!r.bus_factor_risk,
          complexity: r.complexity,
        }));
        process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
      } else if (rows.length === 0) {
        console.log(chalk.gray('No hotspot data found. Run a full sync with --path in a git repo first.'));
      } else {
        console.log(chalk.blue(`Hotspots (${rows.length}):\n`));
        for (const r of rows) {
          const icon = r.bus_factor_risk ? chalk.red(' ⚠ BUS-FACTOR') : '';
          const typeColor = r.type === 'function' ? chalk.cyan : chalk.yellow;
          const scorePct = Math.round(r.score * 100);
          const bar = scorePct > 0 ? '█'.repeat(Math.max(1, Math.round(scorePct / 5))) : '';
          console.log(
            `  ${typeColor(`[${r.type}]`)} ${r.target}` +
            `\n    score: ${chalk.bold(`${scorePct}%`)} ${chalk.gray(bar)}` +
            `  churn: ${r.commit_count} commits (${r.distinct_authors} authors)` +
            `  complexity: ${r.complexity}` +
            `${r.dominant_author ? `  owner: ${r.dominant_author} (${Math.round(r.dominant_author_share * 100)}%)` : ''}` +
            `${icon}`,
          );
        }
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

// ── Risk command — Spec 14 R2 ───────────────────────────────────────
program
  .command('risk')
  .description('Rank functions by architectural risk (PageRank × betweenness × complexity × untested)')
  .option('--limit <n>', 'Max entries to show', '20')
  .option('--path <dir>', 'Project path', process.cwd())
  .option('--json', 'Output as JSON')
  .option('--format <format>', 'Output format: dot (call-graph neighborhood of top functions)')
  .action(async (options) => {
    try {
      const db = CodeIndexDB.getInstance();
      await db.initialize();
      const rawDb = db.rawDb;

      const { computeRisk, buildCallGraphFromCache } = await import('./graph/callGraph.js');
      const { graph: callGraph } = buildCallGraphFromCache(rawDb);
      const riskEntries = computeRisk(
        rawDb,
        callGraph.adjacency,
        callGraph.nodeIds,
        callGraph.nodeNames,
        callGraph.nodePaths
      );
      const limit = parseInt(options.limit, 10) || 20;
      const top = riskEntries.slice(0, limit);

      if (options.format === 'dot') {
        // DOT output: call-graph neighborhood of top-N risk functions
        const { callGraphToDot } = await import('./graph/outputFormatter.js');

        // Collect IDs for top risk functions
        const topIds = new Set<number>();
        for (const e of top) {
          const rows = rawDb.prepare(
            'SELECT id FROM functions WHERE name = ? AND file_path = ?'
          ).all(e.functionName, e.filePath) as Array<{ id: number }>;
          for (const r of rows) topIds.add(r.id);
        }

        const dot = callGraphToDot(callGraph, {
          label: `Call Graph — Top ${top.length} Risk Functions`,
          maxNodes: 60,
          rankdir: 'LR',
          showWeights: true,
        });
        process.stdout.write(dot);
      } else if (options.json) {
        process.stdout.write(JSON.stringify(top.map(e => ({
          functionName: e.functionName,
          filePath: e.filePath,
          pageRankPercentile: Math.round(e.pageRankPercentile * 1000) / 1000,
          betweennessPercentile: Math.round(e.betweennessPercentile * 1000) / 1000,
          complexityPercentile: Math.round(e.complexityPercentile * 1000) / 1000,
          untested: e.untested,
          riskScore: Math.round(e.riskScore * 1000) / 1000,
        })), null, 2) + '\n');
      } else if (top.length === 0) {
        console.log(chalk.gray('No risk data available. Run a full sync (code-audit index sync) first.'));
      } else {
        console.log(chalk.blue(`Risk Rankings (${top.length} of ${riskEntries.length}):\n`));
        console.log(chalk.gray(
          'Rank  Function                            File                                PR%    BW%    CX%   Untested   Risk'
        ));
        console.log(chalk.gray(
          '────  ────────                            ────                                ───    ───    ───   ────────   ────'
        ));
        for (let i = 0; i < top.length; i++) {
          const e = top[i];
          const fnName = e.functionName.length > 36 ? e.functionName.slice(0, 33) + '...' : e.functionName.padEnd(36);
          const fp = (e.filePath || '').length > 36 ? '...' + (e.filePath || '').slice(-33) : (e.filePath || '').padEnd(36);
          const prPct = String(Math.round(e.pageRankPercentile * 100)).padStart(4);
          const bwPct = String(Math.round(e.betweennessPercentile * 100)).padStart(4);
          const cxPct = String(Math.round(e.complexityPercentile * 100)).padStart(4);
          const untested = e.untested ? chalk.red(' ✗      ') : chalk.green(' ✓      ');
          const riskScore = String((Math.round(e.riskScore * 1000) / 1000).toFixed(3)).padStart(6);
          console.log(
            `  ${chalk.dim(String(i + 1).padStart(3))}  ${chalk.bold(fnName)}  ${chalk.green(fp)}  ${prPct}  ${bwPct}  ${cxPct}  ${untested}  ${chalk.yellow(riskScore)}`
          );
        }
        console.log(chalk.gray('\nPR% = PageRank percentile, BW% = Betweenness percentile, CX% = Complexity percentile'));
        console.log(chalk.gray('Risk = max(PR%, BW%) × CX% × (1 + untested)'));
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

const ledgerCmd = program
  .command('ledger')
  .description('View and manage the findings ledger (append-only audit history)');

ledgerCmd
  .command('list')
  .description('List recent audit runs')
  .option('--limit <n>', 'Max runs to show', '20')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const { listRuns } = await import('./ledger.js');
      const db = CodeIndexDB.getInstance();
      await db.initialize();
      const runs = listRuns(db.rawDb);
      const limit = parseInt(options.limit, 10) || 20;
      const limited = runs.slice(0, limit);

      if (options.json) {
        process.stdout.write(JSON.stringify(limited, null, 2) + '\n');
      } else if (limited.length === 0) {
        console.log(chalk.gray('No audit runs in the ledger yet. Run an audit first.'));
      } else {
        console.log(chalk.blue(`Ledger runs (${limited.length} of ${runs.length}):`));
        for (const r of limited) {
          const dirty = (r as any).gitDirty ? chalk.yellow(' [dirty]') : '';
          console.log(`  ${chalk.bold(r.runId.slice(0, 8))}  ${r.timestamp}  ${r.surface}/${r.scope}  ${r.findingCount} findings  ${r.durationMs}ms  exit=${r.exitStatus}${dirty}`);
        }
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

ledgerCmd
  .command('export')
  .description('Export ledger as JSON')
  .option('--since <iso>', 'Only runs from this ISO timestamp')
  .option('--json', 'Output as JSON (always on for export)')
  .action(async (options) => {
    try {
      const { exportLedger } = await import('./ledger.js');
      const db = CodeIndexDB.getInstance();
      await db.initialize();
      const data = exportLedger(db.rawDb, options.since);
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

ledgerCmd
  .command('stats')
  .description('Show aggregated ledger statistics')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const { getLedgerStats } = await import('./ledger.js');
      const db = CodeIndexDB.getInstance();
      await db.initialize();
      const stats = getLedgerStats(db.rawDb);

      if (options.json) {
        process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
      } else {
        console.log(chalk.blue(`Total runs: ${stats.totalRuns}`));
        for (const [analyzer, a] of Object.entries(stats.perAnalyzer)) {
          console.log(chalk.bold(`\n${analyzer} (${a.total} findings):`));
          for (const [rule, count] of Object.entries(a.perRule)) {
            console.log(`  ${rule}: ${count}`);
          }
          const sev = a.severityDistribution;
          if (Object.keys(sev).length > 0) {
            console.log(`  severity: ${Object.entries(sev).map(([k, v]) => `${k}=${v}`).join(', ')}`);
          }
        }
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

ledgerCmd
  .command('trends')
  .description('Compare consecutive full-audit runs and report new vs fixed findings per rule')
  .option('--since <runId>', 'Only consider runs after this run ID')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const { getTrends } = await import('./ledger.js');
      const db = CodeIndexDB.getInstance();
      await db.initialize();
      const trends = getTrends(db.rawDb, options.since);

      if (options.json) {
        process.stdout.write(JSON.stringify(trends, null, 2) + '\n');
      } else if (!trends) {
        console.log(chalk.gray('Need at least 2 full-audit runs of the same target for trend analysis.'));
      } else {
        console.log(chalk.blue(`Trends for ${chalk.bold(trends.target)}`));
        console.log(chalk.gray(`  ${trends.runPairs.length} run pairs from ${trends.timeRange.start} to ${trends.timeRange.end}\n`));

        // Sort rules by |net| descending
        const rules = Object.values(trends.perRule).sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

        if (rules.length === 0) {
          console.log(chalk.gray('No trend changes detected — findings are stable across runs.'));
        } else {
          for (const r of rules) {
            const netIcon = r.net > 0 ? chalk.green(`↓${r.net}`) : r.net < 0 ? chalk.red(`↑${-r.net}`) : chalk.gray('→0');
            console.log(
              `  ${chalk.bold(r.rule)}` +
              `  new: ${chalk.red(r.newCount)}` +
              `  fixed: ${chalk.green(r.fixedCount)}` +
              `  net: ${netIcon}`,
            );
          }
        }

        // Comparison basis
        console.log(chalk.gray(`\nComparison basis: target=${trends.target}, ${trends.runPairs.length} consecutive full-audit pairs`));
        if (options.since) {
          console.log(chalk.gray(`Filter: since run ${options.since.slice(0, 8)}`));
        }
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

ledgerCmd
  .command('import')
  .description('Import D1 interim ledger files from a directory')
  .requiredOption('--dir <path>', 'Directory of JSON run files')
  .action(async (options) => {
    try {
      const { importLedgerFromDir } = await import('./ledger.js');
      const db = CodeIndexDB.getInstance();
      await db.initialize();
      const result = importLedgerFromDir(db.rawDb, options.dir);
      console.log(chalk.green(`✓ Imported ${result.imported} runs, skipped ${result.skipped}`));
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

// ── Spec 41 — Detached runs & queryable findings (CLI) ──────────────────────
// `audit --detach` forks workers/auditJobRunner; `status`/`result`/`jobs` read
// the persisted ledger. One job model (the ledger run), one write path — these
// are thin wrappers over ledger.ts + mcpAuditJobs.ts, not a second store.

/** Full analyzer set — matches createAuditRunner's registry, so `--detach` produces
 *  the same per-rule coverage as a synchronous `audit` (73 rows on recall). */
const DETACHED_DEFAULT_ANALYZERS = [
  'solid',
  'dry',
  'data-access',
  'react',
  'documentation',
  'invariants',
  'schema',
  'styles',
  'conventions',
  'cross-domain',
];

/** Lease TTL used by read-path reclaim, mirroring mcpAuditJobs.jobLeaseTtlMs. */
const CLI_JOB_LEASE_TTL_MS = Number(process.env.CODE_AUDITOR_JOB_LEASE_TTL_MS) || 30_000;

function spec41StatusBadge(status: string): string {
  switch (status) {
    case 'completed':
      return chalk.green('completed');
    case 'running':
      return chalk.cyan('running');
    case 'queued':
      return chalk.blue('queued');
    case 'failed':
      return chalk.red('failed');
    default:
      return status;
  }
}

function spec41SeverityColor(severity: string): (s: string) => string {
  if (severity === 'critical') return chalk.red;
  if (severity === 'warning') return chalk.yellow;
  return chalk.gray;
}

/**
 * Render a run's staleness: the cheap marker (changed count) plus, when stale,
 * the per-file diff. The cheap stat-only pass in `computeStaleness` populates
 * `changedFiles` on divergence, so this list is the full `--stale` deliverable
 * regardless of whether the caller requested `full`. Bounded so a mass-change
 * doesn't flood the terminal; the JSON path always carries the complete list.
 */
function spec41RenderStaleness(staleness: { stale: boolean; changedFiles: string[] } | null): void {
  if (!staleness) {
    console.log(chalk.gray('  stale:    n/a'));
    return;
  }
  if (!staleness.stale) {
    console.log(chalk.gray('  stale:    no (working tree unchanged)'));
    return;
  }
  console.log(chalk.yellow(`  stale:    ${staleness.changedFiles.length} file(s) changed since run`));
  const maxFiles = 20;
  for (const f of staleness.changedFiles.slice(0, maxFiles)) {
    console.log(chalk.yellow(`            + ${f}`));
  }
  if (staleness.changedFiles.length > maxFiles) {
    console.log(chalk.gray(`            … and ${staleness.changedFiles.length - maxFiles} more`));
  }
}

/**
 * Spec 41 — `audit --detach`. Persists a `queued` run, opens a per-run log as
 * the child's stderr, and forks workers/auditJobRunner detached. Returns with
 * the job id; the parent never parses or hashes, so it stays sub-second even
 * on a minutes-long corpus.
 */
async function runDetachedAudit(options: {
  path?: string;
  partitionStrategy?: string;
  maxPartitions?: string;
  shardTimeoutMs?: string;
}): Promise<void> {
  // `spawn` + no IPC channel: `fork()` establishes an IPC channel, and `unref()`
  // does NOT let the parent exit while that channel is open (Node: "unless there
  // is an established IPC channel"). The runner talks to the ledger through the
  // DB, never back to the parent, so there is no channel to keep — and without
  // one the parent exits immediately, keeping `--detach` sub-second.
  const { spawn } = await import('node:child_process');
  const { openSync } = await import('node:fs');
  const { createAuditJob } = await import('./services/auditJobService.js');
  const { patchLedgerRun } = await import('./ledger.js');
  const { resolveJobRunnerEntrypoint } = await import('./mcpAuditJobs.js');
  const { assertAuditPathExists } = await import('./mcpToolErrors.js');
  const { getPersistedStorageRoot } = await import('./dataPaths.js');

  const auditPath = resolve(options.path || process.cwd());
  const { isFile } = await assertAuditPathExists(auditPath);
  const projectRoot = isFile ? dirname(auditPath) : auditPath;

  const db = CodeIndexDB.getInstance(undefined, projectRoot);
  await db.initialize();

  const job = createAuditJob(db.rawDb, projectRoot, { surface: 'cli', command: 'audit --detach' });

  // The log is the diagnosable trace when the child dies before its first DB
  // patch (e.g. inside initParsers()). Lives next to the index db.
  const logsDir = join(getPersistedStorageRoot(projectRoot), 'logs');
  await fs.mkdir(logsDir, { recursive: true });
  const logPath = join(logsDir, `${job.jobId}.log`);
  const logFd = openSync(logPath, 'a');

  const argsJson = JSON.stringify({
    path: auditPath,
    ...(options.partitionStrategy && { partitionStrategy: options.partitionStrategy }),
    ...(options.maxPartitions && { maxPartitions: Number(options.maxPartitions) }),
    ...(options.shardTimeoutMs && { shardTimeoutMs: Number(options.shardTimeoutMs) }),
  });
  const defaultsJson = JSON.stringify({
    defaultAnalyzers: DETACHED_DEFAULT_ANALYZERS,
    defaultMinSeverity: 'warning',
    defaultGenerateCodeMap: false,
  });

  patchLedgerRun(db.rawDb, job.jobId, { stderrLog: logPath });

  const child = spawn(process.execPath, [resolveJobRunnerEntrypoint(), job.jobId, argsJson, defaultsJson], {
    detached: true,
    stdio: ['ignore', 'ignore', logFd],
    env: process.env,
  });
  child.unref();

  console.log(chalk.green(`✓ Audit detached (job ${job.jobId})`));
  console.log(chalk.gray(`  Monitor: code-auditor status ${job.jobId}`));
  console.log(chalk.gray(`  Results: code-auditor result ${job.jobId}`));
  console.log(chalk.gray(`  Log:     ${logPath}`));
}

program
  .command('status <jobId>')
  .description('Show a detached audit job status, progress, and staleness')
  .option('-p, --path <path>', 'Project root containing the job (default: cwd)', process.cwd())
  .option('--json', 'Output as JSON')
  .action(async (jobId: string, options: { path: string; json?: boolean }) => {
    try {
      const { getLedgerRun, reclaimStaleRunning, computeStaleness } = await import('./ledger.js');
      const projectRoot = resolve(options.path);
      const db = CodeIndexDB.getInstance(undefined, projectRoot);
      await db.initialize();

      reclaimStaleRunning(db.rawDb, projectRoot, CLI_JOB_LEASE_TTL_MS);

      const run = getLedgerRun(db.rawDb, jobId);
      if (!run) {
        console.error(chalk.red(`Job not found: ${jobId}`));
        process.exit(1);
      }

      const staleness = run.projectRoot ? computeStaleness(db.rawDb, jobId, run.projectRoot) : null;

      if (options.json) {
        process.stdout.write(JSON.stringify({ ...run, staleness }, null, 2) + '\n');
        return;
      }

      let progress = '';
      if (run.progressJson) {
        try {
          const p = JSON.parse(run.progressJson) as { phase?: string; message?: string; current?: number; total?: number };
          progress = [p.phase, p.message].filter(Boolean).join(' — ');
          if (p.total != null) progress += ` (${p.current ?? 0}/${p.total})`;
        } catch {
          progress = '';
        }
      }

      console.log(chalk.blue(`Job ${jobId}`));
      console.log(`  status:   ${spec41StatusBadge(run.status)}`);
      console.log(`  path:     ${run.projectRoot ?? run.target}`);
      console.log(`  created:  ${run.timestamp}`);
      if (run.startedAt) console.log(`  started:  ${run.startedAt}`);
      if (run.finishedAt) console.log(`  finished: ${run.finishedAt}`);
      if (run.durationMs) console.log(`  duration: ${run.durationMs}ms`);
      if (progress) console.log(`  progress: ${progress}`);
      if (run.error) console.log(chalk.red(`  error:    ${run.error}`));
      if (run.stderrLog) console.log(chalk.gray(`  log:      ${run.stderrLog}`));
      if (run.contentHash) console.log(chalk.gray(`  content:  ${run.contentHash.slice(0, 12)} (${run.filesCount} files)`));
      spec41RenderStaleness(staleness);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

program
  .command('result <jobId>')
  .description('Query a detached audit run: findings or per-rule coverage')
  .option('-p, --path <path>', 'Project root containing the job (default: cwd)', process.cwd())
  .option('--rule <rule>', 'Filter by rule id')
  .option('--analyzer <analyzer>', 'Filter by analyzer')
  .option('--file <file>', 'Filter by file path (substring match)')
  .option('--severity <severity>', 'Filter by severity (critical|warning|suggestion)')
  .option('--state [state]', 'Query coverage by state (fired|clean|notApplicable|unassessed); omit value for all')
  .option('--count', 'Group findings by analyzer/rule with counts')
  .option('--limit <n>', 'Max findings to return (0 = unbounded)', '50')
  .option('--offset <n>', 'Findings offset', '0')
  .option('--stale', 'Force full content re-hash for staleness')
  .option('--json', 'Output as JSON')
  .action(
    async (
      jobId: string,
      options: {
        path: string;
        rule?: string;
        analyzer?: string;
        file?: string;
        severity?: string;
        state?: string | boolean;
        count?: boolean;
        limit: string;
        offset: string;
        stale?: boolean;
        json?: boolean;
      },
    ) => {
      try {
        const { getLedgerRun, queryLedgerFindings, queryLedgerCoverage, computeStaleness } = await import('./ledger.js');
        const projectRoot = resolve(options.path);
        const db = CodeIndexDB.getInstance(undefined, projectRoot);
        await db.initialize();

        const run = getLedgerRun(db.rawDb, jobId);
        if (!run) {
          console.error(chalk.red(`Job not found: ${jobId}`));
          process.exit(1);
        }

        const staleness = run.projectRoot
          ? computeStaleness(db.rawDb, jobId, run.projectRoot, { full: !!options.stale })
          : null;

        // A finding read must never be silent about the tree it was computed
        // against (Spec 41 R3): carry the staleness marker in human output too.
        if (!options.json) spec41RenderStaleness(staleness);

        if (options.state !== undefined) {
          const stateFilter = typeof options.state === 'string' ? (options.state as import('./types.js').RuleCoverageState) : undefined;
          const rows = queryLedgerCoverage(db.rawDb, jobId, {
            ...(stateFilter ? { state: stateFilter } : {}),
            ...(options.rule ? { rule: options.rule } : {}),
            ...(options.analyzer ? { analyzer: options.analyzer } : {}),
          });
          if (options.json) {
            process.stdout.write(JSON.stringify({ runId: jobId, staleness, coverage: rows }, null, 2) + '\n');
          } else {
            console.log(chalk.blue(stateFilter ? `Coverage — ${stateFilter}` : 'Coverage — all states'));
            for (const r of rows) {
              const reason = r.reason ? chalk.gray(`  (${r.reason})`) : '';
              console.log(`  ${r.analyzer}/${r.ruleId}: ${r.state} × ${r.count}${reason}`);
            }
            if (rows.length === 0) console.log(chalk.gray('  (no rows)'));
          }
          return;
        }

        const findingFilter = {
          ...(options.rule ? { rule: options.rule } : {}),
          ...(options.analyzer ? { analyzer: options.analyzer } : {}),
          ...(options.file ? { file: options.file } : {}),
          ...(options.severity ? { severity: options.severity } : {}),
        };

        if (options.count) {
          const groups = queryLedgerFindings(db.rawDb, jobId, { ...findingFilter, count: true }) as Array<{
            group: string;
            count: number;
          }>;
          if (options.json) {
            process.stdout.write(JSON.stringify({ runId: jobId, staleness, groups }, null, 2) + '\n');
          } else {
            console.log(chalk.blue('Findings by analyzer/rule'));
            for (const g of groups) console.log(`  ${g.count}\t${g.group}`);
            if (groups.length === 0) console.log(chalk.gray('  (no findings)'));
          }
          return;
        }

        const limit = options.limit === '0' ? 0 : parseInt(options.limit, 10) || 50;
        const offset = parseInt(options.offset, 10) || 0;
        const findings = queryLedgerFindings(db.rawDb, jobId, { ...findingFilter, limit, offset }) as Array<
          import('./ledger.js').LedgerFindingRecord
        >;

        if (options.json) {
          const nextOffset = limit > 0 && findings.length === limit ? offset + limit : null;
          process.stdout.write(
            JSON.stringify({ runId: jobId, staleness, count: findings.length, nextOffset, findings }, null, 2) + '\n',
          );
        } else {
          console.log(chalk.blue(`Findings (${findings.length} shown)`));
          for (const f of findings) {
            const loc = f.line != null ? `${f.file}:${f.line}` : f.file;
            const paint = spec41SeverityColor(f.severity);
            console.log(`  ${paint(f.severity)} ${chalk.gray(loc)} [${f.analyzer}/${f.rule}] ${f.message}`);
          }
          if (findings.length === 0) console.log(chalk.gray('  (no findings)'));
          if (limit > 0 && findings.length === limit) {
            console.log(chalk.gray(`  next offset: ${offset + limit} (use --offset ${offset + limit})`));
          }
        }
      } catch (error) {
        console.error(chalk.red('Error:'), error);
        process.exit(1);
      }
    },
  );

program
  .command('jobs')
  .description('List detached audit jobs with staleness badges')
  .option('-p, --path <path>', 'Project root (default: cwd)', process.cwd())
  .option('--prune', 'Delete all but the newest runs for this project')
  .option('--keep <n>', 'Runs to keep when --prune is set', '10')
  .option('--limit <n>', 'Runs to display (staleness computed for these)', '20')
  .option('--json', 'Output as JSON')
  .action(
    async (options: { path: string; prune?: boolean; keep: string; limit: string; json?: boolean }) => {
      try {
        const { listLedgerRuns, reclaimStaleRunning, pruneLedgerRuns, computeStaleness } = await import('./ledger.js');
        const projectRoot = resolve(options.path);
        const db = CodeIndexDB.getInstance(undefined, projectRoot);
        await db.initialize();

        reclaimStaleRunning(db.rawDb, projectRoot, CLI_JOB_LEASE_TTL_MS);

        if (options.prune) {
          const keep = parseInt(options.keep, 10) || 10;
          const n = pruneLedgerRuns(db.rawDb, projectRoot, keep);
          console.log(chalk.green(`✓ Pruned ${n} run(s) — keeping ${keep} newest`));
        }

        const limit = parseInt(options.limit, 10) || 20;
        const runs = listLedgerRuns(db.rawDb, projectRoot).slice(0, limit);

        const withStaleness = runs.map((run) => {
          let staleness = null;
          if (run.projectRoot && run.contentHash) {
            staleness = computeStaleness(db.rawDb, run.runId, run.projectRoot);
          }
          return { ...run, staleness };
        });

        if (options.json) {
          process.stdout.write(JSON.stringify(withStaleness, null, 2) + '\n');
          return;
        }

        if (withStaleness.length === 0) {
          console.log(chalk.gray('No jobs yet — run `code-auditor audit --detach` first.'));
          return;
        }

        console.log(chalk.blue(`Jobs (${withStaleness.length} newest)`));
        for (const run of withStaleness) {
          const badge = run.staleness?.stale
            ? chalk.yellow('stale')
            : run.staleness
              ? chalk.green('current')
              : chalk.gray('n/a');
          console.log(`  ${spec41StatusBadge(run.status)}  ${chalk.cyan(run.runId)}  [${badge}]`);
          console.log(`    ${run.projectRoot ?? run.target}  ${run.timestamp}`);
          if (run.error) console.log(`    ${chalk.red(run.error)}`);
        }
      } catch (error) {
        console.error(chalk.red('Error:'), error);
        process.exit(1);
      }
    },
  );

// ── Conventions command — Spec 12 R3 ────────────────────────────────────────
const conventionsCmd = program
  .command('conventions')
  .description('List mined codebase conventions and propose enforceable rules');

conventionsCmd
  .command('list')
  .description('List mined conventions from the code index')
  .option('--domain <domain>', 'Filter by domain: usage-pair, import-form, error-handling, export-shape, naming')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const db = CodeIndexDB.getInstance();
      await db.initialize();
      const rawDb = db.rawDb;

      let sql = 'SELECT * FROM conventions';
      let params: any[] = [];
      if (options.domain) {
        sql += ' WHERE domain = ?';
        params = [options.domain];
      }
      sql += ' ORDER BY domain, directory, confidence DESC';

      const conventions = rawDb.prepare(sql).all(...params) as any[];

      if (options.json) {
        process.stdout.write(JSON.stringify(conventions, null, 2) + '\n');
      } else if (conventions.length === 0) {
        console.log(chalk.gray('No conventions mined yet. Run a full audit or index sync first.'));
      } else {
        // Group by domain for display
        const byDomain = new Map<string, any[]>();
        for (const c of conventions) {
          const list = byDomain.get(c.domain) ?? [];
          list.push(c);
          byDomain.set(c.domain, list);
        }
        console.log(chalk.blue(`Mined conventions (${conventions.length} total):\n`));
        for (const [domain, list] of byDomain) {
          console.log(chalk.bold(`  ${domain} (${list.length})`));
          for (const c of list.slice(0, 5)) {
            const exemplar = c.exemplar_file
              ? ` (exemplar: ${c.exemplar_file}${c.exemplar_line ? `:${c.exemplar_line}` : ''})`
              : '';
            const pct = Math.round(c.confidence * 100);
            const desc =
              domain === 'usage-pair'
                ? `${c.antecedent} → ${c.consequent}`
                : domain === 'import-form'
                  ? `${c.antecedent} → ${c.consequent}`
                  : domain === 'error-handling'
                    ? `shape: ${c.pattern}`
                    : domain === 'export-shape'
                      ? `form: ${c.pattern}`
                      : `case: ${c.pattern}`; // naming
            const dir = c.directory ? `  [${c.directory}]` : '';
            console.log(`    ${desc}  ${pct}% (${c.support}/${c.total_cases})${dir}${exemplar}`);
          }
          if (list.length > 5) {
            console.log(chalk.gray(`    ... and ${list.length - 5} more`));
          }
          console.log('');
        }
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

conventionsCmd
  .command('propose')
  .description('Emit ready-to-paste .codeauditor.json rules from mined conventions')
  .option('--domain <domain>', 'Filter by domain: naming or import-form (other domains do not map to rule kinds)')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const db = CodeIndexDB.getInstance();
      await db.initialize();
      const rawDb = db.rawDb;

      let sql = 'SELECT * FROM conventions';
      let params: any[] = [];
      if (options.domain) {
        sql += ' WHERE domain = ?';
        params = [options.domain];
      }
      sql += ' ORDER BY domain, directory, confidence DESC';

      const conventions = rawDb.prepare(sql).all(...params) as any[];

      interface ProposedRule {
        kind: string;
        message: string;
        description: string;
        paths?: string[];
        pattern?: string;
        exports?: string;
        module?: string;
        allow?: { from?: string[] };
        except?: Array<{ source: string; form: string }>;
      }

      const proposals: ProposedRule[] = [];

      for (const c of conventions) {
        switch (c.domain) {
          case 'naming': {
            if (!c.directory || !c.pattern) continue;
            proposals.push({
              kind: 'naming',
              message: `Use ${c.pattern} naming in ${c.directory}/ (${Math.round(c.confidence * 100)}% convention)`,
              description: `Exported symbols in ${c.directory}/ should use ${c.pattern}`,
              paths: [`${c.directory}/*`],
              pattern: getNamingPattern(c.pattern),
              exports: '**',
            });
            break;
          }
          case 'import-form': {
            if (!c.antecedent || !c.consequent) continue;
            proposals.push({
              kind: 'import-ban',
              message: `Import '${c.antecedent}' with module form in ${c.directory || '.'}/ (${Math.round(c.confidence * 100)}% convention)`,
              description: `In ${c.directory || '.'}/, imports of '${c.antecedent}' should use ${c.consequent} form`,
              module: c.antecedent,
              except: [{ source: c.directory || '.', form: c.consequent }],
            });
            break;
          }
          default:
            // usage-pair, error-handling, export-shape: no existing rule kind
            break;
        }
      }

      if (options.json) {
        process.stdout.write(JSON.stringify(proposals, null, 2) + '\n');
      } else if (proposals.length === 0) {
        console.log(chalk.gray('No proposals available. Only naming and import-form conventions map to rule kinds.'));
        console.log(chalk.gray('Usage-pair, error-handling, and export-shape are detector-only.'));
      } else {
        console.log(chalk.blue(`Proposed rules (${proposals.length}):\n`));
        for (const p of proposals) {
          console.log(chalk.green(`  // ${p.message}`));
          console.log(JSON.stringify(p, null, 4).split('\n').map(l => `  ${l}`).join('\n'));
          console.log('');
        }
        console.log(chalk.gray('# Copy the rule objects above into the "rules" array in .codeauditor.json'));
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

/**
 * Map a case name to a regex pattern for the naming rule kind.
 */
function getNamingPattern(caseName: string): string {
  switch (caseName) {
    case 'PascalCase': return '^[A-Z][a-zA-Z0-9]*$';
    case 'camelCase': return '^[a-z][a-zA-Z0-9]*$';
    case 'UPPER_SNAKE': return '^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$';
    case 'snake_case': return '^[a-z][a-z0-9]*(_[a-z0-9]+)*$';
    case 'kebab-case': return '^[a-z][a-z0-9]*(-[a-z0-9]+)*$';
    default: return '^.*$';
  }
}

// Install command — copy skill folder to agent-specific paths
program
  .command('install')
  .description('Install the code-auditor skill for AI coding tools')
  .option('--agent <agent>', 'Target agent: claude, cursor, codex, gemini, agents, or all', 'all')
  .option('--scope <scope>', 'Install scope: user (~) or project (.)', 'user')
  .option('--hooks', 'Offer hook wiring (default)', true)
  .option('--no-hooks', 'Skip hook wiring prompt')
  .option('--list', 'Print the support matrix and exit')
  .action(async (options) => {
    try {
      const { runInstall } = await import('./installer.js');
      await runInstall({
        agent: options.agent,
        scope: options.scope as 'user' | 'project',
        hooks: options.hooks,
        list: options.list,
      });
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

// ── Architecture command — Spec 14 R3/R4 ────────────────────────────────
program
  .command('architecture')
  .description('Analyze import graph: community detection, directory purity, Martin instability metrics')
  .option('--path <dir>', 'Project path', process.cwd())
  .option('--json', 'Output as JSON')
  .option('--format <format>', 'Output format: dot or mermaid (import graph colored by community)')
  .action(async (options) => {
    try {
      const db = CodeIndexDB.getInstance();
      await db.initialize();
      const rawDb = db.rawDb;

      const {
        buildImportGraphFromCache,
        detectCommunities,
        computeDirectoryPurity,
        computeMartinMetrics,
      } = await import('./graph/importGraph.js');

      const importGraph = buildImportGraphFromCache(rawDb);

      if (importGraph.filePaths.size === 0) {
        if (options.json) {
          process.stdout.write(JSON.stringify({ error: 'No import graph data. Run a full sync first.' }) + '\n');
        } else {
          console.log(chalk.gray('No import graph data. Run a full sync (code-audit index sync) first.'));
        }
        return;
      }

      const communities = detectCommunities(importGraph.adjacency, importGraph.filePaths);
      const purity = computeDirectoryPurity(communities.communities, importGraph.filePaths);
      const martin = computeMartinMetrics(rawDb, importGraph);

      if (options.format === 'dot' || options.format === 'mermaid') {
        // Emit import graph colored by community
        const { importGraphToDot, importGraphToMermaid } = await import('./graph/outputFormatter.js');

        if (options.format === 'dot') {
          const dot = importGraphToDot(importGraph, {
            label: 'Import Graph — Colored by Community',
            communities: communities.communities,
            rankdir: 'LR',
            showWeights: true,
            legend: true,
          });
          process.stdout.write(dot);
        } else {
          const mermaid = importGraphToMermaid(importGraph, {
            label: 'Import Graph — Colored by Community',
            communities: communities.communities,
            showWeights: true,
          });
          process.stdout.write(mermaid);
        }
        return;
      }

      if (options.json) {
        process.stdout.write(JSON.stringify({
          communityCount: communities.communityCount,
          modularity: Math.round(communities.modularity * 10000) / 10000,
          directoryPurity: purity.directoryPurities.map(d => ({
            directory: d.directory,
            totalFiles: d.totalFiles,
            pluralityCommunity: d.pluralityCommunity,
            pluralityCount: d.pluralityCount,
            purity: Math.round(d.purity * 10000) / 10000,
          })),
          splitCandidates: purity.splitCandidates.map(s => ({
            directory: s.directory,
            communities: s.communities,
            fileCounts: s.fileCounts,
          })),
          mergeCandidates: purity.mergeCandidates.map(m => ({
            directories: m.directories,
            community: m.community,
            fileCount: m.fileCount,
          })),
          agreementScore: Math.round(purity.agreementScore * 10000) / 10000,
          martinMetrics: martin.map(m => ({
            directory: m.directory,
            ce: m.ce,
            ca: m.ca,
            instability: Math.round(m.instability * 10000) / 10000,
            abstractness: Math.round(m.abstractness * 10000) / 10000,
            distanceFromMain: Math.round(m.distanceFromMain * 10000) / 10000,
          })),
        }, null, 2) + '\n');
      } else {
        // Community summary
        console.log(chalk.blue('🏗️  Architecture Analysis\n'));
        console.log(chalk.bold('Community Detection (Louvain):'));
        console.log(chalk.gray(`  ${communities.communityCount} communities detected (modularity: ${communities.modularity.toFixed(4)})`));

        // Directory Purity
        if (purity.directoryPurities.length > 0) {
          console.log(chalk.bold('\nDirectory Purity (agreement score: ') + chalk.yellow(purity.agreementScore.toFixed(2)) + chalk.bold(')\n'));
          console.log(chalk.gray(
            '  Directory                                  Files  Plurality  Purity'
          ));
          console.log(chalk.gray(
            '  ─────────                                  ─────  ─────────  ──────'
          ));
          for (const d of purity.directoryPurities) {
            const dirName = d.directory.length > 40 ? '...' + d.directory.slice(-37) : d.directory.padEnd(40);
            const files = String(d.totalFiles).padStart(5);
            const comm = String(d.pluralityCommunity).padStart(9);
            const pur = (d.purity * 100).toFixed(0).padStart(4) + '%';
            const purColor = d.purity >= 0.8 ? chalk.green(pur) : d.purity >= 0.5 ? chalk.yellow(pur) : chalk.red(pur);
            console.log(`  ${chalk.dim(dirName)}  ${files}  ${comm}  ${purColor}`);
          }
        }

        // Split Candidates
        if (purity.splitCandidates.length > 0) {
          console.log(chalk.bold('\n🔀 Split Candidates (directories spanning ≥2 communities):'));
          for (const s of purity.splitCandidates) {
            console.log(chalk.yellow(`  ${s.directory}`));
            for (let i = 0; i < s.communities.length; i++) {
              console.log(chalk.gray(`    Community ${s.communities[i]}: ${s.fileCounts[i]} files`));
            }
          }
        }

        // Merge Candidates
        if (purity.mergeCandidates.length > 0) {
          console.log(chalk.bold('\n🔗 Merge Candidates (one community dominating ≥2 directories):'));
          for (const m of purity.mergeCandidates) {
            const dirs = m.directories.join(', ');
            console.log(chalk.green(`  Community ${m.community}: ${dirs} (${m.fileCount} files)`));
          }
        }

        // Martin Metrics
        console.log(chalk.bold('\nMain-Sequence Distance (Martin Metrics):\n'));
        if (martin.length === 0) {
          console.log(chalk.gray('  No directory-level metrics available.'));
        } else {
          console.log(chalk.gray(
            '  Directory                                  Ce   Ca     I     A    |D|'
          ));
          console.log(chalk.gray(
            '  ─────────                                  ──   ──   ────  ────  ────'
          ));
          // Sort by distance from main sequence descending
          const sorted = [...martin].sort((a, b) => b.distanceFromMain - a.distanceFromMain);
          for (const m of sorted.slice(0, 30)) {
            const dirName = m.directory.length > 40 ? '...' + m.directory.slice(-37) : m.directory.padEnd(40);
            const ce = String(m.ce).padStart(3);
            const ca = String(m.ca).padStart(3);
            const inst = m.instability.toFixed(2).padStart(5);
            const abst = m.abstractness.toFixed(2).padStart(5);
            const dist = m.distanceFromMain.toFixed(2).padStart(5);
            const distColor = m.distanceFromMain <= 0.3 ? chalk.green(dist) : m.distanceFromMain <= 0.5 ? chalk.yellow(dist) : chalk.red(dist);
            console.log(`  ${chalk.dim(dirName)}  ${ce}  ${ca}  ${inst}  ${abst}  ${distColor}`);
          }
          console.log(chalk.gray('\n  Ce = efferent couplings, Ca = afferent couplings'));
          console.log(chalk.gray('  I = Ce/(Ca+Ce), A = abstractness, |D| = |A+I−1|'));
          console.log(chalk.gray('  Ideal: |D| → 0 (close to main sequence)'));
        }
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

// Cursor hook adapter — postToolUse (Write matcher) → scoped audit → additional_context + exit 2
// Verified 2026-07-20: cursor.com/docs/hooks + cursor.com/docs/reference/third-party-hooks
program
  .command('cursor-hook')
  .description('Internal: Cursor postToolUse hook adapter (blocks edits with critical violations via additional_context)')
  .action(async () => {
    try {
      await import('./hooks/cursor.js');
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

// Codex hook adapter — stdin JSON → diff-scoped audit → stdout JSON (blocking)
program
  .command('codex-hook')
  .description('Internal: Codex PostToolUse hook adapter (reads stdin JSON, runs audit, exits 2 on critical violations)')
  .action(async () => {
    try {
      await import('./hooks/codex.js');
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

// ── Coverage command — Spec 15 R4 ─────────────────────────────────────

const coverageCmd = program
  .command('coverage')
  .description('Import and report test coverage data');

coverageCmd
  .command('import')
  .description('Import a coverage file (lcov .info or Istanbul JSON)')
  .argument('<path>', 'Path to the coverage file')
  .option('--project-root <path>', 'Project root for resolving relative paths', process.cwd())
  .action(async (filePath: string, options: { projectRoot: string }) => {
    try {
      const { importCoverageFile } = await import('./coverage/coverageService.js');
      const result = await importCoverageFile(filePath, options.projectRoot);
      console.log(chalk.green(`Imported ${result.format} coverage:`));
      console.log(`  Format:        ${result.format}`);
      console.log(`  Files:         ${result.filesImported}`);
      console.log(`  Entries:       ${result.entriesImported}`);
      console.log(`  Source:        ${result.source}`);
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

coverageCmd
  .command('by-risk', { isDefault: true })
  .description('Show coverage rate by risk decile')
  .option('--json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    try {
      const { generateCoverageReport } = await import('./coverage/coverageService.js');
      const report = await generateCoverageReport();

      if (options.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        return;
      }

      console.log(chalk.blue(`Coverage Report:\n`));
      console.log(`  Total functions:     ${report.totalFunctions}`);
      console.log(`  Covered functions:   ${report.coveredFunctions}`);
      console.log(`  Coverage rate:       ${(report.coverageRate * 100).toFixed(1)}%`);
      if (report.staleImport) {
        console.log(chalk.yellow(`  ⚠ Coverage data is stale — sync index and re-import`));
      }

      console.log(chalk.blue(`\n  By Risk Decile:`));
      if (report.byRiskDecile.length === 0) {
        console.log(chalk.gray('    No data available. Run a full audit with hotspot scoring first.'));
      } else {
        for (const d of report.byRiskDecile) {
          const bar = renderBar(d.rate, 20);
          console.log(
            `    Decile ${String(d.decile).padStart(2)}: ${bar} ${(d.rate * 100).toFixed(0)}% ` +
            `(${d.covered}/${d.total})`,
          );
        }
      }

      console.log(chalk.blue(`\n  Untested Top-Risk Functions:`));
      if (report.untestedTopDecile.length === 0) {
        console.log(chalk.green('    All top-risk functions have coverage.'));
      } else {
        for (const fn of report.untestedTopDecile.slice(0, 10)) {
          console.log(
            `    ${chalk.yellow('⚠')} ${fn.functionName} (risk: ${fn.riskScore.toFixed(3)}) — ${fn.filePath}`,
          );
        }
        if (report.untestedTopDecile.length > 10) {
          console.log(chalk.gray(`    ... and ${report.untestedTopDecile.length - 10} more`));
        }
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

// print-config command — effective config with source attribution (Spec 38 R1)
program
  .command('print-config <file>')
  .description('Print the effective config for a file, naming the source of every value')
  .option('-p, --path <path>', 'Project path', process.cwd())
  .option('--json', 'Output as JSON')
  .option('--preset <id>', 'Apply a shareable preset (repeatable)', (v: string, prev: string[]) => prev.concat([v]), [])
  .action(async (file, options) => {
    try {
      const pathModule = await import('path');
      const fs = await import('fs/promises');
      const { loadConfig } = await import('./config/configLoader.js');
      const { getDefaultConfig, DEFAULT_CODE_INDEX_CONFIG } = await import('./config/defaults.js');
      const {
        computeEffectiveConfig,
        computeTopLevelConfig,
      } = await import('./config/effectiveConfig.js');
      const { getPreset, PRESET_IDS } = await import('./presets/presets.js');

      const projectRoot = pathModule.resolve(options.path);
      const filePath = pathModule.resolve(file);
      const configPath = pathModule.join(projectRoot, '.codeauditor.json');

      // Pristine defaults, normalized against projectRoot the same way loadConfig
      // normalizes the real config, so path keys compare cleanly instead of
      // reading as "user-set" because one side is absolute and the other is not.
      const pristine: any = { ...getDefaultConfig(), codeIndex: { ...DEFAULT_CODE_INDEX_CONFIG } };
      if (pristine.outputDirectory) {
        pristine.outputDirectory = pathModule.resolve(projectRoot, pristine.outputDirectory);
      }
      pristine.includePaths = (pristine.includePaths ?? []).map((p: string) =>
        pathModule.isAbsolute(p) ? p : pathModule.resolve(projectRoot, p));
      pristine.excludePaths = (pristine.excludePaths ?? []).map((p: string) =>
        pathModule.isAbsolute(p) ? p : pathModule.resolve(projectRoot, p));

      // Load the project config (defaults when no config file exists).
      let config: any;
      try {
        await fs.access(configPath);
        config = await loadConfig({ configPath });
      } catch {
        config = pristine;
      }

      const analyzerConfigs = (config.analyzerConfigs ?? {}) as Record<string, unknown>;
      const pathProfiles = (config.pathProfiles ?? []) as any[];
      const enabledAnalyzers = (config.enabledAnalyzers ?? []) as string[];

      // Resolve --preset ids to ordered preset objects (Spec 38 R4). Unknown
      // ids are a hard error, not a silent skip.
      const presetIds: string[] = Array.isArray(options.preset) ? options.preset : (options.preset ? [options.preset] : []);
      for (const id of presetIds) {
        if (!getPreset(id)) {
          console.error(chalk.red(`Error: unknown preset "${id}". Available: ${PRESET_IDS.join(', ')}`));
          process.exit(1);
        }
      }
      const presets = presetIds.map((id) => getPreset(id)!);

      const effective = computeEffectiveConfig({
        filePath,
        projectRoot,
        analyzerConfigs,
        pathProfiles,
        enabledAnalyzers,
        presets,
      });

      const topLevel = computeTopLevelConfig(
        pristine as Record<string, unknown>,
        config as Record<string, unknown>,
      );

      if (options.json) {
        process.stdout.write(JSON.stringify({
          file: filePath,
          projectRoot,
          configPath,
          presets: presetIds,
          matchedProfiles: effective.matchedProfiles,
          excludeFromGate: effective.excludeFromGate ?? null,
          topLevel,
          analyzers: effective.analyzers,
        }, null, 2) + '\n');
        return;
      }

      console.log(chalk.blue('🔧 Effective Config'));
      console.log(chalk.gray('════════════════════════════════════════════════════'));
      console.log(`${chalk.bold('file:')}        ${effective.relativePath}`);
      console.log(`${chalk.bold('project root:')} ${projectRoot}`);
      console.log(`${chalk.bold('presets:')}     ${presetIds.length > 0 ? presetIds.join(', ') : chalk.gray('(none)')}`);
      console.log(`${chalk.bold('profiles:')}    ${effective.matchedProfiles.length > 0 ? effective.matchedProfiles.join(', ') : chalk.gray('(none)')}`);
      if (effective.excludeFromGate) {
        console.log(`${chalk.bold('excludeFromGate:')} ${chalk.yellow('true')}`);
      }

      // Top-level keys
      console.log(chalk.bold('\n── Top-level ──'));
      for (const key of topLevel) {
        const flag = key.differsFromDefault ? chalk.yellow(' [differs from default]') : '';
        console.log(
          `${key.key.padEnd(24)} ${chalk.dim(JSON.stringify(key.value))}  ${chalk.cyan(key.source)}${flag}`,
        );
      }

      // Per-analyzer keys
      for (const analyzer of effective.analyzers) {
        console.log(chalk.bold(`\n── ${analyzer.namespace} ──`));
        for (const key of analyzer.keys) {
          const flag = key.differsFromDefault
            ? chalk.yellow(` [differs from default: ${JSON.stringify(key.defaultValue)}]`)
            : '';
          console.log(
            `${key.key.padEnd(32)} ${chalk.dim(JSON.stringify(key.value))}  ${chalk.cyan(key.source)}${flag}`,
          );
        }
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

// Outstanding command (Spec 36 R8) — "what is outstanding" is re-derived from
// the codebase on every invocation, never read from a stored list. The answer a
// compacted agent gets is identical to an uncompacted one because the only input
// is the code itself: run the audit, list the findings. No progress file, no
// tracked count, no state that can drift from the code.
program
  .command('outstanding')
  .description('List outstanding findings, re-derived from the codebase (never a stored list)')
  .option('-p, --path <path>', 'Path to audit', process.cwd())
  .option('--json', 'Output findings as machine-readable JSON')
  .action(async (options) => {
    try {
      await initParsers();

      const runner = createAuditRunner({ projectRoot: options.path });
      const result = await runner.run();

      const violations = Object.values(result.analyzerResults).flatMap(
        (r: any) => r.violations || []
      );

      // Deterministic order — same answer every run, independent of analyzer
      // registration order or any prior agent state. Sort by file, then line,
      // then rule. This is what makes a compacted and uncompacted agent agree.
      const sorted = [...violations].sort((a: any, b: any) => {
        const fa = a.file ?? '';
        const fb = b.file ?? '';
        if (fa !== fb) return fa < fb ? -1 : 1;
        const la = a.line ?? 0;
        const lb = b.line ?? 0;
        if (la !== lb) return la - lb;
        const ra = a.rule ?? '';
        const rb = b.rule ?? '';
        if (ra !== rb) return ra < rb ? -1 : 1;
        return 0;
      });

      if (options.json) {
        const projectDir = resolve(options.path || process.cwd());
        const out = sorted.map((v: any) => {
          let filePath = v.file || '';
          if (filePath.startsWith('/')) {
            const rel = relative(projectDir, filePath);
            if (!rel.startsWith('..') && !isAbsolute(rel)) filePath = rel;
          }
          return {
            rule: v.rule || v.type || '',
            analyzer: v.analyzer || '',
            severity: v.severity,
            file: filePath,
            line: v.line ?? v.start?.line,
            message: v.message,
            resolution: v.resolution ?? null,
            suppressed: (v as any).suppressed === true,
            ...((v as any).suppressionReason && { suppressionReason: (v as any).suppressionReason }),
          };
        });
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
        return;
      }

      // Spec 36 R3 — findings, never a total. Each line is a file:line finding;
      // there is no count anywhere in this output to route around.
      for (const v of sorted) {
        const icon =
          v.severity === 'critical' ? '🔴' :
          v.severity === 'warning' ? '🟡' : '🔵';
        const suppressed = (v as any).suppressed ? chalk.dim(' [suppressed]') : '';
        console.log(
          `${icon} ${chalk.bold(v.file)}${v.line ? `:${v.line}` : ''} [${v.rule || v.severity}] ${v.message}${suppressed}`
        );
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

/**
 * Render a simple ASCII bar chart.
 */
function renderBar(value: number, width: number): string {
  const filled = Math.round(value * width);
  const empty = width - filled;
  const color = value > 0.8 ? chalk.green : value > 0.5 ? chalk.yellow : chalk.red;
  return color('█'.repeat(filled) + '░'.repeat(empty));
}

// Parse command line arguments
program.parse(process.argv);

// If no command was provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}

/**
 * Generate configurations for AI tools
 */
/**
 * Rule kind metadata for interactive mode.
 */
interface RuleKindInfo {
  kind: string;
  label: string;
  description: string;
  requiredFields: string[];
}

const RULE_KINDS: RuleKindInfo[] = [
  {
    kind: 'import-ban',
    label: 'Import Ban — forbid importing a specific module',
    description: 'No file may import the banned module (e.g. deprecated packages, legacy libraries).',
    requiredFields: ['module'],
  },
  {
    kind: 'call-constraint',
    label: 'Call Constraint — restrict who can call a function',
    description: 'Only allow or deny specific callers from invoking a function.',
    requiredFields: ['callee'],
  },
  {
    kind: 'module-boundary',
    label: 'Module Boundary — enforce layer isolation',
    description: 'Files matching a "from" glob may not import from files matching a "to" glob.',
    requiredFields: ['from', 'to'],
  },
  {
    kind: 'naming',
    label: 'Naming — enforce export naming conventions',
    description: 'Exported symbols in matching files must match a regex pattern.',
    requiredFields: ['path', 'exports'],
  },
  {
    kind: 'ast-pattern',
    label: 'AST Pattern — ban syntactic patterns',
    description: 'Match AST nodes using ast-grep patterns (e.g. "new Function($$$)").',
    requiredFields: ['pattern'],
  },
];

const SCAFFOLD_CONFIG: Record<string, unknown> = {
  $schema: 'https://unpkg.com/code-auditor-mcp/dist/invariant-rules.schema.json',
  rules: [
    {
      id: 'ban-deprecated-lib',
      kind: 'import-ban',
      severity: 'critical',
      message: 'This module is deprecated — prefer the replacement instead.',
      module: 'deprecated-lib',
    },
    {
      id: 'data-layer-no-browser',
      kind: 'module-boundary',
      severity: 'critical',
      message: 'Data access layer must not import from browser-only modules.',
      from: 'src/data/**',
      to: 'src/browser/**',
    },
    {
      id: 'api-routes-naming',
      kind: 'naming',
      severity: 'warning',
      message: 'API route files must export a handler matching the HTTP method.',
      path: 'src/api/**',
      exports: '^(get|post|put|delete|patch)\\b',
    },
    {
      id: 'no-eval',
      kind: 'ast-pattern',
      severity: 'critical',
      pattern: 'eval($$$)',
      message: 'eval() is forbidden in this codebase.',
    },
  ],
};

async function generateConfigurations(options: any): Promise<void> {
  const outputDir = resolve(options.output || '.');
  const outputPath = join(outputDir, '.codeauditor.json');

  let config: Record<string, unknown>;

  if (options.interactive) {
    // --- Interactive rule builder ---
    console.log(chalk.cyan('\nBuild your .codeauditor.json interactively.\n'));

    const { addRules } = await inquirer.prompt({
      addRules: {
        type: 'confirm',
        message: 'Would you like to add invariant rules?',
        default: true,
      },
    } as any);

    if (!addRules) {
      console.log(chalk.yellow('No rules selected. Writing empty config.'));
      config = { $schema: SCAFFOLD_CONFIG.$schema, rules: [] };
    } else {
      config = await buildRulesInteractively();
    }

    // Confirm output directory
    if (!options.force && !options.yes) {
      const { dir } = await inquirer.prompt({
        dir: {
          type: 'input',
          message: 'Output directory:',
          default: outputDir,
        },
      } as any);
      // Re-resolve with the user's choice (they might just hit enter)
      const chosenDir = resolve(dir || outputDir);
      const chosenPath = join(chosenDir, '.codeauditor.json');

      // Check for existing file
      let exists = false;
      try { await fs.access(chosenPath); exists = true; } catch { /* ok */ }
      if (exists) {
        const { overwrite } = await inquirer.prompt({
          overwrite: {
            type: 'confirm',
            message: chalk.yellow(`.codeauditor.json already exists at ${chosenPath}. Overwrite?`),
            default: false,
          },
        } as any);
        if (!overwrite) {
          console.log(chalk.yellow('Operation cancelled.'));
          return;
        }
      }

      await writeConfigFile(chosenPath, config);
    } else {
      await writeConfigFile(outputPath, config);
    }
  } else {
    // --- Non-interactive: scaffold template ---
    let exists = false;
    try { await fs.access(outputPath); exists = true; } catch { /* ok */ }

    if (exists && !options.force && !options.yes) {
      console.log(chalk.yellow(`.codeauditor.json already exists at ${outputPath}`));
      console.log(chalk.gray('Use --force or --yes to overwrite, or --interactive to build a custom config.'));
      return;
    }

    if (exists && (options.force || options.yes)) {
      console.log(chalk.yellow('Overwriting existing .codeauditor.json...'));
    }

    config = SCAFFOLD_CONFIG;
    await writeConfigFile(outputPath, config);
  }

  console.log(chalk.blue('\nNext steps:'));
  console.log(chalk.gray('  1. Edit .codeauditor.json to match your codebase conventions'));
  console.log(chalk.gray('  2. Run ') + chalk.cyan('code-audit') + chalk.gray(' to enforce your rules'));
  console.log(chalk.gray('  3. Use ') + chalk.cyan('code-audit changed') + chalk.gray(' in your agent hook (gating rules block on new findings)'));
}

/**
 * Interactive rule builder — walks the user through adding rules one at a time.
 */
async function buildRulesInteractively(): Promise<Record<string, unknown>> {
  const rules: Record<string, unknown>[] = [];
  let addMore = true;

  while (addMore) {
    console.log(chalk.gray(`\n── Rule ${rules.length + 1} ──`));

    // Select rule kind
    const { kind } = await inquirer.prompt({
      kind: {
        type: 'list',
        message: 'Select rule kind:',
        choices: RULE_KINDS.map((k) => ({
          name: k.label,
          value: k.kind,
        })),
        pageSize: 10,
      },
    } as any);

    const kindInfo = RULE_KINDS.find((k) => k.kind === kind)!;
    console.log(chalk.dim(kindInfo.description));

    // Common fields
    const common = await inquirer.prompt({
      id: {
        type: 'input',
        message: 'Rule ID (unique kebab-case identifier):',
        validate: (input: string) => {
          if (!input.trim()) return 'Rule ID is required';
          if (!/^[a-z][a-z0-9-]*$/.test(input)) return 'Use kebab-case (lowercase, digits, hyphens)';
          return true;
        },
      },
      severity: {
        type: 'list',
        message: 'Severity:',
        choices: [
          { name: chalk.red('Critical — exit code 2, blocks the agent loop'), value: 'critical' },
          { name: chalk.yellow('Warning — visible, non-blocking'), value: 'warning' },
          { name: chalk.blue('Suggestion — informational'), value: 'suggestion' },
        ],
        default: 'warning',
      },
      message: {
        type: 'input',
        message: 'Violation message (shown when rule is broken):',
        validate: (input: string) => input.trim() ? true : 'Message is required',
      },
    } as any);

    const rule: Record<string, unknown> = {
      id: common.id,
      kind,
      severity: common.severity,
      message: common.message,
    };

    // Kind-specific fields
    switch (kind) {
      case 'import-ban': {
        const { module } = await inquirer.prompt({
          module: {
            type: 'input',
            message: 'Banned module specifier (e.g. "lodash" or "@old-lib/*"):',
            validate: (input: string) => input.trim() ? true : 'Module specifier is required',
          },
        } as any);
        rule.module = module;
        const { addExcept } = await inquirer.prompt({
          addExcept: {
            type: 'confirm',
            message: 'Add exception paths (files allowed to import it)?',
            default: false,
          },
        } as any);
        if (addExcept) {
          const { except } = await inquirer.prompt({
            except: {
              type: 'input',
              message: 'Exception globs (comma-separated, e.g. "src/migration/**"):',
            },
          } as any);
          const exceptList = except.split(',').map((s: string) => s.trim()).filter(Boolean);
          if (exceptList.length > 0) rule.except = exceptList;
        }
        break;
      }
      case 'call-constraint': {
        const { callee } = await inquirer.prompt({
          callee: {
            type: 'input',
            message: 'Callee (function name, optionally path-qualified as "path/glob#name"):',
            validate: (input: string) => input.trim() ? true : 'Callee is required',
          },
        } as any);
        rule.callee = callee;
        const { mode } = await inquirer.prompt({
          mode: {
            type: 'list',
            message: 'Restriction mode:',
            choices: [
              { name: 'Allow only specific callers (allowFrom)', value: 'allow' },
              { name: 'Deny specific callers (denyFrom)', value: 'deny' },
            ],
          },
        } as any);
        const { paths } = await inquirer.prompt({
          paths: {
            type: 'input',
            message: `Path globs (comma-separated) for ${mode === 'allow' ? 'allowFrom' : 'denyFrom'}:`,
            validate: (input: string) => input.trim() ? true : 'At least one path glob is required',
          },
        } as any);
        const pathList = paths.split(',').map((s: string) => s.trim()).filter(Boolean);
        if (mode === 'allow') {
          rule.allowFrom = pathList;
        } else {
          rule.denyFrom = pathList;
        }
        break;
      }
      case 'module-boundary': {
        const { from, to } = await inquirer.prompt({
          from: {
            type: 'input',
            message: 'From (path glob for files that must not import):',
            validate: (input: string) => input.trim() ? true : '"from" path glob is required',
          },
          to: {
            type: 'input',
            message: 'To (path glob for files that must not be imported):',
            validate: (input: string) => input.trim() ? true : '"to" path glob is required',
          },
        } as any);
        rule.from = from;
        rule.to = to;
        break;
      }
      case 'naming': {
        const { path, exports: exportPattern } = await inquirer.prompt({
          path: {
            type: 'input',
            message: 'Path (glob for files this rule applies to):',
            validate: (input: string) => input.trim() ? true : 'Path glob is required',
          },
          exports: {
            type: 'input',
            message: 'Exports regex (exported symbols must match, e.g. "^use[A-Z]"):',
            validate: (input: string) => input.trim() ? true : 'Exports regex is required',
          },
        } as any);
        rule.path = path;
        rule.exports = exportPattern;
        break;
      }
      case 'ast-pattern': {
        const { pattern } = await inquirer.prompt({
          pattern: {
            type: 'input',
            message: 'AST pattern (ast-grep syntax, e.g. "new Function($$$)"):',
            validate: (input: string) => input.trim() ? true : 'Pattern is required',
          },
        } as any);
        rule.pattern = pattern;
        const { addLanguage } = await inquirer.prompt({
          addLanguage: {
            type: 'confirm',
            message: 'Restrict to a specific language? (default: typescript)',
            default: false,
          },
        } as any);
        if (addLanguage) {
          const { language } = await inquirer.prompt({
            language: {
              type: 'list',
              message: 'Language:',
              choices: ['typescript', 'javascript', 'go'],
            },
          } as any);
          rule.language = language;
        }
        break;
      }
    }

    rules.push(rule);
    console.log(chalk.green(`  ✓ Added rule "${rule.id}" [${rule.kind}]`));

    const { cont } = await inquirer.prompt({
      cont: {
        type: 'confirm',
        message: 'Add another rule?',
        default: true,
      },
    } as any);
    addMore = cont;
  }

  return {
    $schema: 'https://unpkg.com/code-auditor-mcp/dist/invariant-rules.schema.json',
    rules,
  };
}

async function writeConfigFile(outputPath: string, config: Record<string, unknown>): Promise<void> {
  await fs.mkdir(dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(config, null, 2) + '\n');
  console.log(chalk.green(`\n✓ Written .codeauditor.json to ${outputPath}`));
}

/**
 * Generate code map for a project
 */
async function generateCodeMap(options: any): Promise<void> {
  const projectPath = resolve(options.path);
  
  console.log(chalk.gray(`Project path: ${projectPath}`));
  console.log(chalk.gray('Generating code map...'));
  console.log('');

  try {
    // Create code map generator
    const mapGenerator = new CodeMapGenerator();

    // Parse CLI options into CodeMapOptions format
    const mapOptions = {
      includeComplexity: options.complexity,
      includeDocumentation: options.documentation,
      includeDependencies: options.dependencies,
      includeUsage: options.includeUsage || false,
      groupByDirectory: options.groupByDirectory,
      maxDepth: parseInt(options.maxDepth) || 10,
      showUnusedImports: options.unusedImports,
      minComplexity: parseInt(options.minComplexity) || 7,
    };

    console.log(chalk.gray('Options:'));
    console.log(chalk.gray(`  • Include complexity: ${mapOptions.includeComplexity}`));
    console.log(chalk.gray(`  • Include documentation: ${mapOptions.includeDocumentation}`));
    console.log(chalk.gray(`  • Include dependencies: ${mapOptions.includeDependencies}`));
    console.log(chalk.gray(`  • Include usage info: ${mapOptions.includeUsage}`));
    console.log(chalk.gray(`  • Group by directory: ${mapOptions.groupByDirectory}`));
    console.log(chalk.gray(`  • Max files per directory: ${mapOptions.maxDepth}`));
    console.log('');

    // Generate the code map
    console.log(chalk.gray('Reading indexed functions...'));
    const codeMap = await mapGenerator.generateCodeMap(projectPath, mapOptions);

    // Generate documentation metrics if requested
    let documentation: { coverageScore: number } | undefined = undefined;
    if (mapOptions.includeDocumentation) {
      try {
        console.log(chalk.gray('Analyzing documentation quality...'));
        // For CLI usage, we'll skip documentation analysis since we don't have files from audit
        // Documentation analysis works best when integrated with the audit process
        console.log(chalk.gray('  (Documentation analysis skipped in standalone mode)'));
      } catch (docError) {
        console.log(chalk.yellow('Warning: Failed to analyze documentation:'), docError);
      }
    }

    // Add documentation metrics to the code map
    const completeCodeMap = {
      ...codeMap,
      documentation
    };

    // Format as terminal-friendly text
    console.log(chalk.gray('Formatting output...'));
    const textOutput = mapGenerator.formatAsText(completeCodeMap, mapOptions);

    // Output results
    if (options.output) {
      // Save to file
      await fs.writeFile(options.output, textOutput);
      console.log(chalk.green(`✓ Code map saved to: ${options.output}`));
      
      // Show summary
      console.log('');
      console.log(chalk.blue('Summary:'));
      console.log(chalk.gray(`  • Files analyzed: ${codeMap.stats.totalFiles}`));
      console.log(chalk.gray(`  • Functions found: ${codeMap.stats.totalFunctions}`));
      console.log(chalk.gray(`  • Components found: ${codeMap.stats.totalComponents}`));
      if (documentation) {
        const docMetrics = documentation as { coverageScore: number };
        console.log(chalk.gray(`  • Documentation coverage: ${docMetrics.coverageScore}%`));
      }
    } else {
      // Display to console
      console.log(textOutput);
    }

  } catch (error) {
    if (error instanceof Error && error.message.includes('No functions found')) {
      console.log(chalk.yellow('No indexed functions found for this project.'));
      console.log('');
      console.log(chalk.gray('To index functions, run an audit first:'));
      console.log(chalk.blue('  code-auditor audit --path ') + chalk.gray(projectPath));
      console.log('');
      console.log(chalk.gray('Or use the MCP server with the audit tool to automatically index functions.'));
    } else {
      throw error;
    }
  }
}

/**
 * Run a search query against the code index.
 */
async function runSearch(query: string, options: Record<string, any>): Promise<void> {
  const limit = parseInt(options.limit || '20', 10);
  const db = CodeIndexDB.getInstance();
  await db.initialize();

  // --definition: look up a specific symbol
  if (options.definition) {
    const func = await db.findDefinition(query);
    if (!func) {
      console.log(chalk.yellow(`No definition found for "${query}"`));
      return;
    }
    if (options.json) {
      process.stdout.write(JSON.stringify(func, null, 2) + '\n');
    } else {
      console.log(chalk.blue(`\nDefinition: ${func.name}`));
      console.log(chalk.gray('──────────────────────────────────────────'));
      console.log(`${chalk.bold('File:')} ${func.filePath}${func.lineNumber ? `:${func.lineNumber}` : ''}`);
      if (func.signature) {
        console.log(`${chalk.bold('Signature:')} ${func.signature}`);
      }
      if (func.purpose) {
        console.log(`${chalk.bold('Purpose:')} ${func.purpose}`);
      }
      if (func.language) {
        console.log(`${chalk.bold('Language:')} ${func.language}`);
      }
      if (func.dependencies?.length) {
        console.log(`${chalk.bold('Dependencies:')} ${func.dependencies.join(', ')}`);
      }
      if (func.jsDoc) {
        console.log(`${chalk.bold('JSDoc:')} ${func.jsDoc}`);
      }
    }
    return;
  }

  // Full search: parse the query, build SearchOptions, run search
  const parsed = queryParser.parse(query);
  const searchOptions: SearchOptions = {
    query,
    parsedQuery: parsed,
    limit,
    offset: 0,
    searchStrategy: parsed.fuzzy ? 'fuzzy' : 'exact',
  };

  // Apply --language filter
  if (options.language) {
    if (!searchOptions.filters) {
      searchOptions.filters = {};
    }
    searchOptions.filters.language = options.language;
  }

  const result = await db.searchFunctions(searchOptions);

  if (options.json) {
    process.stdout.write(JSON.stringify({
      query,
      totalCount: result.totalCount,
      executionTime: result.executionTime,
      functions: result.functions,
    }, null, 2) + '\n');
  } else {
    console.log(chalk.blue(`\nSearch: "${query}"`));
    console.log(chalk.gray('──────────────────────────────────────────'));
    console.log(chalk.gray(`Found ${result.totalCount} result${result.totalCount !== 1 ? 's' : ''} in ${result.executionTime}ms`));
    console.log('');

    if (result.functions.length === 0) {
      console.log(chalk.yellow('No results found.'));
      console.log(chalk.gray('Tip: Run an audit first if the index is empty: code-audit audit'));
    } else {
      for (const func of result.functions) {
        const lang = func.language ? chalk.dim(` [${func.language}]`) : '';
        const lineInfo = func.lineNumber ? chalk.dim(`:${func.lineNumber}`) : '';
        console.log(
          `${chalk.bold(func.name)}${lang} — ${chalk.green(func.filePath)}${lineInfo}`
        );
        if (func.signature) {
          console.log(chalk.dim(`  ${func.signature}`));
        }
        if (func.purpose) {
          console.log(chalk.dim(`  ${func.purpose}`));
        }
        // Show score for relevance-sorted results
        if (func.score) {
          console.log(chalk.dim(`  score: ${func.score.toFixed(2)}`));
        }
        console.log('');
      }
    }
  }
}
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
import { analyzeDocumentation } from './analyzers/documentationAnalyzer.js';
import { initParsers } from './languages/index.js';
import { queryParser } from './search/QueryParser.js';
import { CodeIndexDB } from './codeIndexDB.js';
import type { Severity, AuditScope, SearchOptions } from './types.js';

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
  .action(async (options) => {
    console.log(chalk.blue('🔍 Code Quality Audit Tool'));
    console.log(chalk.gray('══════════════════════════════════════════════════'));

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

      const runner = createAuditRunner({
        projectRoot: options.path,
        configName: options.config,
        outputDirectory: options.output
      });

      const result = await runner.run();

      console.log(`\nFound ${result.summary.totalViolations} violations`);
      console.log(`Critical: ${result.summary.criticalIssues}`);
      console.log(`Warnings: ${result.summary.warnings}`);
      console.log(`Suggestions: ${result.summary.suggestions}`);

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
        await fs.writeFile(reportPath, report, 'utf-8');
        console.log(chalk.green(`\nReport written to ${reportPath}`));
      }

      // Exit code based on --fail-on
      if (failOnSeverity) {
        const violations = Object.values(result.analyzerResults).flatMap(
          (r: any) => r.violations || []
        );
        const severityOrder: Severity[] = ['critical', 'warning', 'suggestion'];
        const failIndex = severityOrder.indexOf(failOnSeverity);
        const hasAtOrAbove = violations.some((v: any) => {
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
  .option('--fail-on <severity>', 'Exit code 2 when violations at or above this severity exist', 'critical')
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

      // Validate --fail-on severity
      const validSeverities: Severity[] = ['critical', 'warning', 'suggestion'];
      const failOnSeverity = options.failOn as Severity;
      if (!validSeverities.includes(failOnSeverity)) {
        console.error(
          chalk.red(`Invalid --fail-on severity: "${failOnSeverity}". Must be one of: ${validSeverities.join(', ')}`)
        );
        process.exit(1);
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
            details: v.details || ''
          };
        });
        process.stdout.write(JSON.stringify(jsonOutput, null, 2) + '\n');
      } else if (!options.quiet || violations.length > 0) {
        // Console output
        console.log(chalk.blue('🔍 Diff-Scoped Code Audit'));
        console.log(chalk.gray('══════════════════════════════════════════════════'));
        console.log(chalk.gray(`Files analyzed: ${result.metadata.filesAnalyzed}`));
        console.log(`\nFound ${violations.length} violations`);
        console.log(`Critical: ${result.summary.criticalIssues}`);
        console.log(`Warnings: ${result.summary.warnings}`);
        console.log(`Suggestions: ${result.summary.suggestions}`);

        if (violations.length > 0) {
          console.log(chalk.gray('\n── Violations ────────────────────────────────────'));
          for (const v of violations) {
            const icon =
              v.severity === 'critical' ? '🔴' :
              v.severity === 'warning' ? '🟡' : '🔵';
            console.log(
              `${icon} ${chalk.bold(v.file)}${v.line ? `:${v.line}` : ''} [${v.severity}] ${v.message}`
            );
          }
        }
      }

      // Exit code based on --fail-on
      if (failOnSeverity) {
        const severityOrder: Severity[] = ['critical', 'warning', 'suggestion'];
        const failIndex = severityOrder.indexOf(failOnSeverity);
        const hasAtOrAbove = violations.some((v: any) => {
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
      const db = CodeIndexDB.getInstance();
      await db.initialize();
      const targetPath = resolve(options.path || process.cwd());

      const isSingleFile = (await fs.stat(targetPath).catch(() => null))?.isFile();
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

// Config command
const configCmd = program
  .command('config')
  .description('Manage analyzer configuration and invariant rules')
  .action(() => {
    console.log(chalk.yellow('Use a config subcommand:'));
    console.log(chalk.gray('  code-audit config rules-list       List invariant rules from .codeauditor.json'));
    console.log(chalk.gray('  code-audit config rules-check      Validate .codeauditor.json rules'));
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
  console.log(chalk.gray('  3. Use ') + chalk.cyan('code-audit changed --fail-on critical') + chalk.gray(' in your agent hook'));
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
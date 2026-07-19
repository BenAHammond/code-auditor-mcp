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
import { ConfigGeneratorFactory } from './generators/ConfigGeneratorFactory.js';
import { InteractivePrompts } from './ui/InteractivePrompts.js';
import { DEFAULT_SERVER_URL, DEFAULT_PORT } from './constants.js';
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
  .action(async (options) => {
    console.log(chalk.blue('🔍 Code Quality Audit Tool'));
    console.log(chalk.gray('══════════════════════════════════════════════════'));

    try {
      await initParsers();

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
  .description('Generate configuration for AI coding assistants')
  .option('-t, --tool <tool>', 'Specific tool (cursor, continue, copilot, awsq, codeium, claude, all)')
  .option('-o, --output <dir>', 'Output directory', '.')
  .option('-s, --server-url <url>', 'MCP server URL', DEFAULT_SERVER_URL)
  .option('-i, --interactive', 'Interactive mode for tool selection')
  .option('-f, --force', 'Force overwrite existing files without confirmation')
  .option('-y, --yes', 'Skip all confirmation prompts (same as --force)')
  .action(async (options) => {
    console.log(chalk.blue('🛠️  AI Tool Configuration Generator'));
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
async function generateConfigurations(options: any): Promise<void> {
  const prompts = new InteractivePrompts();
  let tools: string[] = [];
  let serverUrl = options.serverUrl;
  let outputDir = options.output;

  // Determine which tools to configure
  if (options.interactive && !options.tool) {
    // Interactive mode
    tools = await prompts.selectTools();
    if (!options.force && !options.yes) {
      serverUrl = await prompts.confirmServerUrl(serverUrl);
      outputDir = await prompts.selectOutputDirectory(outputDir);
    }
  } else if (!options.tool) {
    // No tool specified and not interactive - show available tools
    const factory = new ConfigGeneratorFactory(serverUrl);
    const availableTools = factory.getToolInfo();
    
    console.log(chalk.yellow('No tool specified. Available tools:'));
    availableTools.forEach(tool => {
      console.log(chalk.gray(`  • ${tool.name} - ${tool.displayName}`));
    });
    console.log(chalk.blue('\nUsage examples:'));
    console.log(chalk.gray('  code-auditor gen --tool cursor'));
    console.log(chalk.gray('  code-auditor gen --tool cursor,claude,continue'));
    console.log(chalk.gray('  code-auditor gen --tool all'));
    console.log(chalk.gray('  code-auditor gen --interactive'));
    return;
  } else {
    // Command line mode
    if (options.tool === 'all') {
      const factory = new ConfigGeneratorFactory(serverUrl);
      tools = factory.getAvailableTools();
    } else {
      tools = options.tool.split(',').map((t: string) => t.trim());
    }
  }

  console.log(chalk.blue(`\nGenerating configurations for: ${tools.join(', ')}`));
  console.log(chalk.gray(`Server URL: ${serverUrl}`));
  console.log(chalk.gray(`Output directory: ${outputDir}\n`));

  // Create factory
  const factory = new ConfigGeneratorFactory(serverUrl);
  const generatedFiles: string[] = [];
  const errors: string[] = [];

  // Check for existing files
  const existingFiles: string[] = [];
  for (const tool of tools) {
    const generator = factory.createGenerator(tool);
    if (generator) {
      const config = generator.generateConfig();
      const outputPath = resolve(outputDir, config.filename);
      
      try {
        await fs.access(outputPath);
        existingFiles.push(config.filename);
      } catch {
        // File doesn't exist, which is fine
      }
    }
  }

  // Confirm overwrite if needed
  if (existingFiles.length > 0 && !options.force && !options.yes) {
    const shouldOverwrite = await prompts.confirmOverwrite(existingFiles);
    if (!shouldOverwrite) {
      console.log(chalk.yellow('Operation cancelled.'));
      return;
    }
  } else if (existingFiles.length > 0 && (options.force || options.yes)) {
    console.log(chalk.yellow(`Overwriting ${existingFiles.length} existing file(s)...`));
  }

  // Generate configurations
  for (const tool of tools) {
    try {
      const generator = factory.createGenerator(tool);
      if (!generator) {
        errors.push(`Unknown tool: ${tool}`);
        continue;
      }

      const config = generator.generateConfig();
      const outputPath = resolve(outputDir, config.filename);

      // Ensure directory exists
      await fs.mkdir(dirname(outputPath), { recursive: true });

      // Write main config file
      await fs.writeFile(outputPath, config.content);
      generatedFiles.push(config.filename);

      // Write additional files if any
      if (config.additionalFiles) {
        for (const additionalFile of config.additionalFiles) {
          const additionalPath = resolve(outputDir, additionalFile.filename);
          await fs.mkdir(dirname(additionalPath), { recursive: true });
          await fs.writeFile(additionalPath, additionalFile.content);
          generatedFiles.push(additionalFile.filename);
        }
      }

      // Show success and instructions
      console.log(chalk.green(`✓ Generated ${generator.getToolName()} configuration: ${config.filename}`));
      console.log(chalk.dim('Instructions:'));
      console.log(chalk.gray(config.instructions.trim()));
      console.log('');

    } catch (error) {
      errors.push(`Failed to generate config for ${tool}: ${error}`);
    }
  }

  // Show summary
  if (generatedFiles.length > 0) {
    prompts.displaySuccess(generatedFiles);
  }

  if (errors.length > 0) {
    console.log(chalk.red('\nErrors:'));
    errors.forEach(error => {
      console.log(chalk.red(`  • ${error}`));
    });
  }
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
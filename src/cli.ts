#!/usr/bin/env node

/**
 * Code Auditor CLI - Enhanced with AI Tool Integration
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { createAuditRunner } from './auditRunner.js';
import { readFileSync } from 'fs';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { ConfigGeneratorFactory } from './generators/ConfigGeneratorFactory.js';
import { InteractivePrompts } from './ui/InteractivePrompts.js';
import { DEFAULT_SERVER_URL, DEFAULT_PORT } from './constants.js';
import { CodeMapGenerator } from './services/CodeMapGenerator.js';
import { analyzeDocumentation } from './analyzers/documentationAnalyzer.js';

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
  .action(async (options) => {
    console.log(chalk.blue('🔍 Code Quality Audit Tool'));
    console.log(chalk.gray('══════════════════════════════════════════════════'));
    
    try {
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

// Index command (placeholder - will be implemented later)
program
  .command('index <path>')
  .description('Index a directory')
  .option('-p, --pattern <pattern>', 'File pattern', '**/*.{js,ts,jsx,tsx}')
  .action(async (path, options) => {
    console.log(chalk.yellow('Index command will be implemented in a future task'));
    console.log('Path:', path, 'Options:', options);
    // TODO: Implement indexing
  });

// Search command (placeholder - will be implemented later)
program
  .command('search <query>')
  .description('Search the code index')
  .option('-f, --fuzzy', 'Use fuzzy search', true)
  .option('-t, --type <type>', 'Symbol type filter')
  .option('-l, --limit <limit>', 'Result limit', '20')
  .action(async (query, options) => {
    console.log(chalk.yellow('Search command will be implemented in a future task'));
    console.log('Query:', query, 'Options:', options);
    // TODO: Implement search
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
    let documentation = undefined;
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
        console.log(chalk.gray(`  • Documentation coverage: ${documentation.coverageScore}%`));
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
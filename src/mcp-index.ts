#!/usr/bin/env node

/**
 * MCP Server Entry Point - Switches between stdio and HTTP/UI modes
 *
 * Usage:
 *   node mcp-index.js              # stdio mode (default)
 *   node mcp-index.js --ui         # HTTP/UI mode
 *   node mcp-index.js --stdio      # explicit stdio mode
 *   node mcp-index.js --data-dir /abs/path   # persist index under that directory
 *   node mcp-index.js --auto-index /project  # index-only harness (no MCP stdio); logs to stderr
 */

import './applyDataDirEnv.js';
import chalk from 'chalk';

function printHelp(): void {
  console.log(`
${chalk.blue('MCP Code Auditor Server')}

Usage:
  ${chalk.cyan('node mcp-index.js')}              # stdio mode (default)
  ${chalk.cyan('node mcp-index.js --ui')}         # HTTP/UI mode
  ${chalk.cyan('node mcp-index.js --stdio')}      # explicit stdio mode
  ${chalk.cyan('node mcp-index.js --data-dir /path')}  # index DB at /path/index.db
  ${chalk.cyan('node mcp-index.js --auto-index /project')}  # discover + index only (testing)

Modes:
  ${chalk.yellow('stdio')}   - Standard MCP protocol over stdin/stdout (for Claude Desktop, VS Code)
  ${chalk.yellow('ui')}      - HTTP server with interactive UI capabilities (for web dashboards)

Examples:
  ${chalk.gray('# For Claude Desktop')}
  node mcp-index.js

  ${chalk.gray('# Index a repo without MCP (stderr logs; use CODE_AUDITOR_DEBUG=1 for verbose)')}
  CODE_AUDITOR_DEBUG=1 node mcp-index.js --auto-index /path/to/repo

Environment Variables:
  ${chalk.cyan('MCP_UI_PORT')}=3001              # Port for UI mode (default: 3001)
  ${chalk.cyan('MCP_MODE')}=stdio|ui             # Override mode detection
  ${chalk.cyan('CODE_AUDITOR_DATA_DIR')}=/path   # Storage directory; index file is /path/index.db
  ${chalk.cyan('CODE_AUDITOR_DEBUG')}=1          # Verbose mcpDiagnostics traces
  ${chalk.cyan('CODE_AUDITOR_LOG_FILE')}=/path   # Append diagnostics lines to this file
`);
}

// Parse command line arguments
const args = process.argv.slice(2);
const helpMode = args.includes('--help') || args.includes('-h');

if (helpMode) {
  printHelp();
  process.exit(0);
}

const autoIndexPos = args.findIndex((a) => a === '--auto-index');
if (autoIndexPos >= 0) {
  const projectPath = args[autoIndexPos + 1];
  if (!projectPath || projectPath.startsWith('-')) {
    console.error('Usage: node mcp-index.js --auto-index <project-root>');
    process.exit(1);
  }
  const { runAutoIndex } = await import('./mcpAutoIndex.js');
  await runAutoIndex(projectPath);
  process.exit(0);
}

const uiMode = args.includes('--ui');
const stdioMode = args.includes('--stdio');

// Determine mode
let mode: 'stdio' | 'ui';

if (process.env.MCP_MODE) {
  mode = process.env.MCP_MODE as 'stdio' | 'ui';
  console.error(chalk.blue('[MCP]'), `Mode set via MCP_MODE environment variable: ${mode}`);
} else if (uiMode) {
  mode = 'ui';
  console.error(chalk.blue('[MCP]'), 'UI mode requested via --ui flag');
} else if (stdioMode) {
  mode = 'stdio';
  console.error(chalk.blue('[MCP]'), 'Stdio mode requested via --stdio flag');
} else {
  // Default to stdio for backward compatibility
  mode = 'stdio';
  console.error(chalk.blue('[MCP]'), 'Defaulting to stdio mode (use --ui for interactive mode)');
}

// Launch the appropriate server
async function startServer() {
  try {
    if (mode === 'ui') {
      console.error(chalk.green('[MCP]'), 'Starting HTTP/UI server...');
      const { startMcpUIServer } = await import('./mcp-ui-simple.js');
      await startMcpUIServer();
    } else {
      console.error(chalk.green('[MCP]'), 'Starting stdio server...');
      await import('./mcp.js');
    }
  } catch (error) {
    console.error(chalk.red('[MCP ERROR]'), 'Failed to start server:', error);
    console.error(chalk.red('[ERROR]'), 'Stack:', error instanceof Error ? error.stack : 'No stack');
    process.exitCode = 1;
  }
}

// Handle shutdown gracefully
process.on('SIGINT', () => {
  console.error(chalk.yellow(`[MCP]`), `Shutting down ${mode} server...`);
  process.exitCode = 0;
});

process.on('SIGTERM', () => {
  console.error(chalk.yellow(`[MCP]`), `Received SIGTERM, shutting down ${mode} server...`);
  process.exitCode = 0;
});

const g = globalThis as {
  __codeAuditorUncaughtExceptionHandlerInstalled?: boolean;
  __codeAuditorUnhandledRejectionHandlerInstalled?: boolean;
};
const exitOnFatal =
  process.env.CODE_AUDITOR_EXIT_ON_FATAL === '1' ||
  process.env.CODE_AUDITOR_EXIT_ON_FATAL === 'true';

if (!g.__codeAuditorUncaughtExceptionHandlerInstalled) {
  process.on('uncaughtException', (error) => {
    console.error(chalk.red('[MCP ERROR]'), 'Uncaught exception:', error);
    console.error(chalk.red('[ERROR]'), 'Stack:', error.stack);
    if (exitOnFatal) {
      process.exit(1);
    }
  });
  g.__codeAuditorUncaughtExceptionHandlerInstalled = true;
}

if (!g.__codeAuditorUnhandledRejectionHandlerInstalled) {
  process.on('unhandledRejection', (reason, promise) => {
    console.error(chalk.red('[MCP ERROR]'), 'Unhandled rejection at:', promise);
    console.error(chalk.red('[ERROR]'), 'Reason:', reason);
    if (exitOnFatal) {
      process.exit(1);
    }
  });
  g.__codeAuditorUnhandledRejectionHandlerInstalled = true;
}

// Start the server
startServer();

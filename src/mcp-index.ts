#!/usr/bin/env node

/**
 * MCP Server Entry Point - Switches between stdio and HTTP/UI modes
 * 
 * Usage:
 *   node mcp-index.js              # stdio mode (default)
 *   node mcp-index.js --ui         # HTTP/UI mode
 *   node mcp-index.js --stdio      # explicit stdio mode
 */

import chalk from 'chalk';

// Parse command line arguments
const args = process.argv.slice(2);
const uiMode = args.includes('--ui');
const stdioMode = args.includes('--stdio');
const helpMode = args.includes('--help') || args.includes('-h');

if (helpMode) {
  console.log(`
${chalk.blue('MCP Code Auditor Server')}

Usage:
  ${chalk.cyan('node mcp-index.js')}              # stdio mode (default)
  ${chalk.cyan('node mcp-index.js --ui')}         # HTTP/UI mode
  ${chalk.cyan('node mcp-index.js --stdio')}      # explicit stdio mode

Modes:
  ${chalk.yellow('stdio')}   - Standard MCP protocol over stdin/stdout (for Claude Desktop, VS Code)
  ${chalk.yellow('ui')}      - HTTP server with interactive UI capabilities (for web dashboards)

Examples:
  ${chalk.gray('# For Claude Desktop')}
  node mcp-index.js

  ${chalk.gray('# For interactive web dashboards')}
  node mcp-index.js --ui

Environment Variables:
  ${chalk.cyan('MCP_UI_PORT')}=3001              # Port for UI mode (default: 3001)
  ${chalk.cyan('MCP_MODE')}=stdio|ui             # Override mode detection
`);
  process.exit(0);
}

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
    process.exit(1);
  }
}

// Handle shutdown gracefully
process.on('SIGINT', () => {
  console.error(chalk.yellow(`[MCP]`), `Shutting down ${mode} server...`);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error(chalk.yellow(`[MCP]`), `Received SIGTERM, shutting down ${mode} server...`);
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error(chalk.red('[MCP ERROR]'), 'Uncaught exception:', error);
  console.error(chalk.red('[ERROR]'), 'Stack:', error.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(chalk.red('[MCP ERROR]'), 'Unhandled rejection at:', promise);
  console.error(chalk.red('[ERROR]'), 'Reason:', reason);
  process.exit(1);
});

// Start the server
startServer();
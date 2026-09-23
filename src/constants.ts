/**
 * Global constants for the code-auditor MCP server
 */

import { VERSION } from './version.generated.js';

/**
 * Package version, stamped into the build by `scripts/write-version.mjs`.
 *
 * This is a compile-time literal, not a runtime `package.json` read. A stale
 * binary therefore reports the version it was actually built as — not the
 * version of whatever package.json sits next to it on disk (the defect where a
 * pre-3.9.4 binary announced itself as 3.9.9).
 */
export const PACKAGE_VERSION = VERSION;

// Default port for the REST API server
// Using 11437 to avoid conflicts with common development servers
// Common ports to avoid: 3000 (React/Next.js), 8080 (Java), 5000 (Flask), 4200 (Angular), 8000 (Django)
export const DEFAULT_PORT = 11437;

// Default server URL
export const DEFAULT_SERVER_URL = `http://localhost:${DEFAULT_PORT}`;

// MCP server name
export const MCP_SERVER_NAME = 'code-index';

// Development mode detection.
//
// Opt-in via an explicit `--dev` flag only. It must NOT key off `NODE_ENV` or
// `DEBUG`: those are generic, framework-set signals that a consumer's dev shell
// sets by default (Next/Vite/tsx all put `NODE_ENV=development` on child
// processes), and tripping them used to drop a bare `mcp-server.log` into the
// consumer's project root — the same silent-write defect as the report writer's
// old cwd default. The previous check also had a loose `process.argv.includes('dev')`
// that matched *any* argument equal to the string "dev", not just the flag.
export const IS_DEV_MODE = process.argv.includes('--dev');
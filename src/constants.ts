/**
 * Global constants for the code-auditor MCP server
 */

// Default port for the REST API server
// Using 11437 to avoid conflicts with common development servers
// Common ports to avoid: 3000 (React/Next.js), 8080 (Java), 5000 (Flask), 4200 (Angular), 8000 (Django)
export const DEFAULT_PORT = 11437;

// Default server URL
export const DEFAULT_SERVER_URL = `http://localhost:${DEFAULT_PORT}`;

// MCP server name
export const MCP_SERVER_NAME = 'code-index';

// Default API key for authentication
export const DEFAULT_API_KEY = 'mcp-code-index';
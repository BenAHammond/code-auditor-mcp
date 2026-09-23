/**
 * API Contract Analyzer for Cross-Language Validation
 * Detects mismatches between frontend and backend APIs
 */

import { TypeSchema, ErrorSchema } from '../../types/crossLanguage.js';
import { Violation } from '../../types.js';

export interface APIEndpoint {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  language: string;
  file: string;
  line: number;
  requestSchema?: TypeSchema;
  responseSchema?: TypeSchema;
  errorSchemas?: ErrorSchema[];
  authentication?: string;
  deprecated?: boolean;
}

export interface APICall {
  id: string;
  method: string;
  url: string;
  language: string;
  file: string;
  line: number;
  expectedResponseType?: string;
  errorHandling?: string[];
  timeout?: number;
}

/**
 * Api contract analyzer.
 *
 * All six api-contract rules were removed in 4.1.0: each was `cannot-fire` (its
 * extractor never populated the fields it read, or its computation was a name
 * proxy). The rules were removed outright rather than kept as standing findings,
 * so this analyzer is a no-op that returns no violations. The endpoint/call
 * extraction below remains for when real contract extraction lands.
 */
export class APIContractAnalyzer {
  /**
   * Detect mismatches between a project's declared API endpoints and the calls
   * its clients make against them.
   *
   * A no-op as of 4.1.0: all six api-contract rules this method fed were removed
   * (each was `cannot-fire`), so it always returns an empty list. Kept as the
   * seam real contract extraction will plug into — the endpoint/call extraction
   * below remains for that work.
   *
   * @param _endpoints The API endpoints extracted from the corpus.
   * @param _calls The API calls extracted from the corpus.
   * @returns An empty list (no contract rules are live).
   */
  async analyzeContracts(
    _endpoints: APIEndpoint[],
    _calls: APICall[]
  ): Promise<Violation[]> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Endpoint/call extraction (pure functions — no analyzer state)
// ---------------------------------------------------------------------------
//
// These stubs remain for when real contract extraction lands (4.1.0 removed the
// six api-contract rules that depended on fields these functions never
// populated). They are not wired to any live rule.

/**
 * Extract API endpoints from code entities
  * @param entities
  * @returns
 */
export function extractEndpoints(entities: any[]): APIEndpoint[] {
  const endpoints: APIEndpoint[] = [];

  for (const entity of entities) {
    // Go endpoints (Gin, Echo, etc.)
    if (entity.language === 'go' && entity.type === 'function') {
      const endpoint = extractGoEndpoint(entity);
      if (endpoint) endpoints.push(endpoint);
    }

    // TypeScript endpoints (Express, Fastify, etc.)
    if (entity.language === 'typescript' && entity.type === 'function') {
      const endpoint = extractTypeScriptEndpoint(entity);
      if (endpoint) endpoints.push(endpoint);
    }

    // Python endpoints (FastAPI, Flask, etc.)
    if (entity.language === 'python' && entity.type === 'function') {
      const endpoint = extractPythonEndpoint(entity);
      if (endpoint) endpoints.push(endpoint);
    }
  }

  return endpoints;
}

/**
 * Extract API calls from code entities
  * @param entities
  * @returns
 */
export function extractAPICalls(entities: any[]): APICall[] {
  const calls: APICall[] = [];

  for (const entity of entities) {
    // TypeScript/JavaScript API calls (fetch, axios, etc.)
    if ((entity.language === 'typescript' || entity.language === 'javascript') && entity.type === 'function') {
      const call = extractTypeScriptAPICall(entity);
      if (call) calls.push(call);
    }

    // Go API calls (http.Client, etc.)
    if (entity.language === 'go' && entity.type === 'function') {
      const call = extractGoAPICall(entity);
      if (call) calls.push(call);
    }
  }

  return calls;
}

function extractGoEndpoint(entity: any): APIEndpoint | null {
  // Look for HTTP handler patterns in Go
  if (entity.signature?.includes('gin.Context') ||
      entity.signature?.includes('echo.Context') ||
      entity.signature?.includes('http.ResponseWriter')) {

    // Extract method and path from function name or comments
    const method = extractMethodFromGo(entity);
    const path = extractPathFromGo(entity);

    if (method && path) {
      return {
        id: entity.id,
        method: method as any,
        path,
        language: 'go',
        file: entity.file,
        line: entity.startLine || 0,
        // Would extract schemas from struct tags or comments
      };
    }
  }
  return null;
}

function extractTypeScriptEndpoint(entity: any): APIEndpoint | null {
  // Look for Express/Fastify handler patterns
  if (entity.signature?.includes('Request') && entity.signature?.includes('Response')) {
    const method = extractMethodFromTypeScript(entity);
    const path = extractPathFromTypeScript(entity);

    if (method && path) {
      return {
        id: entity.id,
        method: method as any,
        path,
        language: 'typescript',
        file: entity.file,
        line: entity.startLine || 0,
      };
    }
  }
  return null;
}

function extractPythonEndpoint(entity: any): APIEndpoint | null {
  // Look for FastAPI/Flask patterns
  if (entity.metadata?.decorators?.some((d: string) =>
      d.includes('@app.') || d.includes('@router.'))) {

    const method = extractMethodFromPython(entity);
    const path = extractPathFromPython(entity);

    if (method && path) {
      return {
        id: entity.id,
        method: method as any,
        path,
        language: 'python',
        file: entity.file,
        line: entity.startLine || 0,
      };
    }
  }
  return null;
}

function extractTypeScriptAPICall(entity: any): APICall | null {
  // Look for fetch/axios patterns
  if (entity.purpose?.includes('fetch') ||
      entity.purpose?.includes('axios') ||
      entity.name.toLowerCase().includes('api') ||
      entity.name.toLowerCase().includes('request')) {

    const method = extractCallMethodFromTypeScript(entity);
    const url = extractUrlFromTypeScript(entity);

    if (method && url) {
      return {
        id: entity.id,
        method,
        url,
        language: 'typescript',
        file: entity.file,
        line: entity.startLine || 0,
      };
    }
  }
  return null;
}

function extractGoAPICall(entity: any): APICall | null {
  // Look for http.Client patterns
  if (entity.signature?.includes('http.Client') ||
      entity.purpose?.includes('HTTP') ||
      entity.name.toLowerCase().includes('request')) {

    const method = extractCallMethodFromGo(entity);
    const url = extractUrlFromGo(entity);

    if (method && url) {
      return {
        id: entity.id,
        method,
        url,
        language: 'go',
        file: entity.file,
        line: entity.startLine || 0,
      };
    }
  }
  return null;
}

// Helper functions for extracting HTTP info from code patterns

function extractMethodFromGo(entity: any): string | null {
  const name = entity.name.toLowerCase();
  if (name.includes('get')) return 'GET';
  if (name.includes('post')) return 'POST';
  if (name.includes('put')) return 'PUT';
  if (name.includes('delete')) return 'DELETE';
  if (name.includes('patch')) return 'PATCH';
  return null;
}

function extractPathFromGo(entity: any): string | null {
  // Extract from function name like GetUserByID -> /user/:id
  const name = entity.name;
  if (name.startsWith('Get') && name.includes('By')) {
    const resource = name.substring(3).split('By')[0].toLowerCase();
    return `/${resource}/:id`;
  }
  if (name.startsWith('List')) {
    const resource = name.substring(4).toLowerCase() + 's';
    return `/${resource}`;
  }
  return '/api/' + name.toLowerCase();
}

function extractMethodFromTypeScript(entity: any): string | null {
  return extractMethodFromGo(entity); // Same logic
}

function extractPathFromTypeScript(entity: any): string | null {
  return extractPathFromGo(entity); // Same logic
}

function extractMethodFromPython(entity: any): string | null {
  return extractMethodFromGo(entity); // Same logic
}

function extractPathFromPython(entity: any): string | null {
  return extractPathFromGo(entity); // Same logic
}

function extractCallMethodFromTypeScript(entity: any): string | null {
  return extractMethodFromGo(entity); // Same logic
}

function extractUrlFromTypeScript(entity: any): string | null {
  // Extract from function name or purpose
  return extractPathFromGo(entity);
}

function extractCallMethodFromGo(entity: any): string | null {
  return extractMethodFromGo(entity); // Same logic
}

function extractUrlFromGo(entity: any): string | null {
  return extractPathFromGo(entity); // Same logic
}

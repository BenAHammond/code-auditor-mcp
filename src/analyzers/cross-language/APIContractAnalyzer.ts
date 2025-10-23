/**
 * API Contract Analyzer for Cross-Language Validation
 * Detects mismatches between frontend and backend APIs
 */

import { CrossReference, APIContract, TypeSchema, ErrorSchema } from '../../types/crossLanguage.js';
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

export interface ContractViolation extends Violation {
  contractType: 'type-mismatch' | 'missing-endpoint' | 'extra-field' | 'missing-field' | 'method-mismatch' | 'auth-mismatch';
  endpoint?: APIEndpoint;
  call?: APICall;
  expectedType?: string;
  actualType?: string;
  missingFields?: string[];
  extraFields?: string[];
}

export class APIContractAnalyzer {
  private endpoints: APIEndpoint[] = [];
  private calls: APICall[] = [];

  /**
   * Analyze API contracts and find violations
   */
  async analyzeContracts(
    endpoints: APIEndpoint[], 
    calls: APICall[]
  ): Promise<ContractViolation[]> {
    this.endpoints = endpoints;
    this.calls = calls;

    const violations: ContractViolation[] = [];

    console.log(`[APIContractAnalyzer] Analyzing ${endpoints.length} endpoints and ${calls.length} API calls`);

    // Find unmatched API calls
    violations.push(...await this.findUnmatchedCalls());

    // Validate matched endpoint-call pairs
    violations.push(...await this.validateMatchedPairs());

    // Check for deprecated API usage
    violations.push(...await this.checkDeprecatedUsage());

    // Validate authentication requirements
    violations.push(...await this.validateAuthentication());

    console.log(`[APIContractAnalyzer] Found ${violations.length} contract violations`);
    return violations;
  }

  /**
   * Extract API endpoints from code entities
   */
  static extractEndpoints(entities: any[]): APIEndpoint[] {
    const endpoints: APIEndpoint[] = [];

    for (const entity of entities) {
      // Go endpoints (Gin, Echo, etc.)
      if (entity.language === 'go' && entity.type === 'function') {
        const endpoint = this.extractGoEndpoint(entity);
        if (endpoint) endpoints.push(endpoint);
      }

      // TypeScript endpoints (Express, Fastify, etc.)
      if (entity.language === 'typescript' && entity.type === 'function') {
        const endpoint = this.extractTypeScriptEndpoint(entity);
        if (endpoint) endpoints.push(endpoint);
      }

      // Python endpoints (FastAPI, Flask, etc.)
      if (entity.language === 'python' && entity.type === 'function') {
        const endpoint = this.extractPythonEndpoint(entity);
        if (endpoint) endpoints.push(endpoint);
      }
    }

    return endpoints;
  }

  /**
   * Extract API calls from code entities
   */
  static extractAPICalls(entities: any[]): APICall[] {
    const calls: APICall[] = [];

    for (const entity of entities) {
      // TypeScript/JavaScript API calls (fetch, axios, etc.)
      if ((entity.language === 'typescript' || entity.language === 'javascript') && entity.type === 'function') {
        const call = this.extractTypeScriptAPICall(entity);
        if (call) calls.push(call);
      }

      // Go API calls (http.Client, etc.)
      if (entity.language === 'go' && entity.type === 'function') {
        const call = this.extractGoAPICall(entity);
        if (call) calls.push(call);
      }
    }

    return calls;
  }

  /**
   * Find API calls that don't have matching endpoints
   */
  private async findUnmatchedCalls(): Promise<ContractViolation[]> {
    const violations: ContractViolation[] = [];

    for (const call of this.calls) {
      const matchingEndpoint = this.findMatchingEndpoint(call);
      if (!matchingEndpoint) {
        violations.push({
          file: call.file,
          line: call.line,
          severity: 'warning',
          message: `API call to ${call.method} ${call.url} has no matching endpoint`,
          contractType: 'missing-endpoint',
          call,
          details: {
            method: call.method,
            url: call.url,
            language: call.language
          },
          suggestion: 'Ensure the endpoint exists or update the API call',
          analyzer: 'api-contract',
          category: 'cross-language-api'
        });
      }
    }

    return violations;
  }

  /**
   * Validate matched endpoint-call pairs for compatibility
   */
  private async validateMatchedPairs(): Promise<ContractViolation[]> {
    const violations: ContractViolation[] = [];

    for (const call of this.calls) {
      const endpoint = this.findMatchingEndpoint(call);
      if (!endpoint) continue;

      // Validate HTTP method
      if (call.method.toUpperCase() !== endpoint.method) {
        violations.push({
          file: call.file,
          line: call.line,
          severity: 'critical',
          message: `HTTP method mismatch: call uses ${call.method}, endpoint expects ${endpoint.method}`,
          contractType: 'method-mismatch',
          endpoint,
          call,
          details: {
            expectedMethod: endpoint.method,
            actualMethod: call.method
          },
          suggestion: `Change the API call method to ${endpoint.method}`,
          analyzer: 'api-contract',
          category: 'cross-language-api'
        });
      }

      // Validate response type compatibility
      if (endpoint.responseSchema && call.expectedResponseType) {
        const typeViolations = this.validateTypeCompatibility(
          endpoint.responseSchema,
          call.expectedResponseType,
          endpoint,
          call
        );
        violations.push(...typeViolations);
      }
    }

    return violations;
  }

  /**
   * Check for usage of deprecated APIs
   */
  private async checkDeprecatedUsage(): Promise<ContractViolation[]> {
    const violations: ContractViolation[] = [];

    for (const call of this.calls) {
      const endpoint = this.findMatchingEndpoint(call);
      if (endpoint?.deprecated) {
        violations.push({
          file: call.file,
          line: call.line,
          severity: 'warning',
          message: `Using deprecated API endpoint: ${endpoint.method} ${endpoint.path}`,
          contractType: 'type-mismatch', // Reusing type for deprecated
          endpoint,
          call,
          details: {
            deprecatedEndpoint: `${endpoint.method} ${endpoint.path}`,
            endpointFile: endpoint.file
          },
          suggestion: 'Update to use the current API version',
          analyzer: 'api-contract',
          category: 'cross-language-api'
        });
      }
    }

    return violations;
  }

  /**
   * Validate authentication requirements
   */
  private async validateAuthentication(): Promise<ContractViolation[]> {
    const violations: ContractViolation[] = [];

    for (const call of this.calls) {
      const endpoint = this.findMatchingEndpoint(call);
      if (!endpoint) continue;

      if (endpoint.authentication && !this.callHasAuthentication(call)) {
        violations.push({
          file: call.file,
          line: call.line,
          severity: 'critical',
          message: `API call missing required authentication for endpoint ${endpoint.method} ${endpoint.path}`,
          contractType: 'auth-mismatch',
          endpoint,
          call,
          details: {
            requiredAuth: endpoint.authentication,
            endpointFile: endpoint.file
          },
          suggestion: `Add ${endpoint.authentication} authentication to the API call`,
          analyzer: 'api-contract',
          category: 'cross-language-api'
        });
      }
    }

    return violations;
  }

  /**
   * Find matching endpoint for an API call
   */
  private findMatchingEndpoint(call: APICall): APIEndpoint | null {
    for (const endpoint of this.endpoints) {
      if (this.pathsMatch(endpoint.path, call.url) && 
          endpoint.method === call.method.toUpperCase()) {
        return endpoint;
      }
    }
    return null;
  }

  /**
   * Check if two API paths match (handling path parameters)
   */
  private pathsMatch(endpointPath: string, callUrl: string): boolean {
    // Simple path matching - in practice would need more sophisticated logic
    // Handle path parameters like /users/:id matching /users/123
    
    const endpointParts = endpointPath.split('/');
    const callParts = callUrl.split('/').map(part => part.split('?')[0]); // Remove query params
    
    if (endpointParts.length !== callParts.length) {
      return false;
    }
    
    for (let i = 0; i < endpointParts.length; i++) {
      const endpointPart = endpointParts[i];
      const callPart = callParts[i];
      
      // Skip parameter parts (starting with : or {})
      if (endpointPart.startsWith(':') || 
          (endpointPart.startsWith('{') && endpointPart.endsWith('}'))) {
        continue;
      }
      
      if (endpointPart !== callPart) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * Validate type compatibility between endpoint and call
   */
  private validateTypeCompatibility(
    endpointSchema: TypeSchema,
    callType: string,
    endpoint: APIEndpoint,
    call: APICall
  ): ContractViolation[] {
    const violations: ContractViolation[] = [];

    // Simplified type checking - in practice would need full schema validation
    if (endpointSchema.type === 'object' && callType.includes('[]')) {
      violations.push({
        file: call.file,
        line: call.line,
        severity: 'critical',
        message: `Type mismatch: endpoint returns object, call expects array`,
        contractType: 'type-mismatch',
        endpoint,
        call,
        expectedType: 'object',
        actualType: 'array',
        details: {
          endpointSchema: endpointSchema,
          callType: callType
        },
        suggestion: 'Update the API call to handle object response instead of array',
        analyzer: 'api-contract',
        category: 'cross-language-api'
      });
    }

    return violations;
  }

  /**
   * Check if an API call includes authentication
   */
  private callHasAuthentication(call: APICall): boolean {
    // Simplified check - would analyze the actual code for auth headers/tokens
    return call.file.includes('auth') || 
           call.id.toLowerCase().includes('token') ||
           call.id.toLowerCase().includes('bearer');
  }

  // Static methods for extracting endpoints and calls from entities

  private static extractGoEndpoint(entity: any): APIEndpoint | null {
    // Look for HTTP handler patterns in Go
    if (entity.signature?.includes('gin.Context') || 
        entity.signature?.includes('echo.Context') ||
        entity.signature?.includes('http.ResponseWriter')) {
      
      // Extract method and path from function name or comments
      const method = this.extractMethodFromGo(entity);
      const path = this.extractPathFromGo(entity);
      
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

  private static extractTypeScriptEndpoint(entity: any): APIEndpoint | null {
    // Look for Express/Fastify handler patterns
    if (entity.signature?.includes('Request') && entity.signature?.includes('Response')) {
      const method = this.extractMethodFromTypeScript(entity);
      const path = this.extractPathFromTypeScript(entity);
      
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

  private static extractPythonEndpoint(entity: any): APIEndpoint | null {
    // Look for FastAPI/Flask patterns
    if (entity.metadata?.decorators?.some((d: string) => 
        d.includes('@app.') || d.includes('@router.'))) {
      
      const method = this.extractMethodFromPython(entity);
      const path = this.extractPathFromPython(entity);
      
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

  private static extractTypeScriptAPICall(entity: any): APICall | null {
    // Look for fetch/axios patterns
    if (entity.purpose?.includes('fetch') || 
        entity.purpose?.includes('axios') ||
        entity.name.toLowerCase().includes('api') ||
        entity.name.toLowerCase().includes('request')) {
      
      const method = this.extractCallMethodFromTypeScript(entity);
      const url = this.extractUrlFromTypeScript(entity);
      
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

  private static extractGoAPICall(entity: any): APICall | null {
    // Look for http.Client patterns
    if (entity.signature?.includes('http.Client') ||
        entity.purpose?.includes('HTTP') ||
        entity.name.toLowerCase().includes('request')) {
      
      const method = this.extractCallMethodFromGo(entity);
      const url = this.extractUrlFromGo(entity);
      
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

  // Helper methods for extracting HTTP info from code patterns

  private static extractMethodFromGo(entity: any): string | null {
    const name = entity.name.toLowerCase();
    if (name.includes('get')) return 'GET';
    if (name.includes('post')) return 'POST';
    if (name.includes('put')) return 'PUT';
    if (name.includes('delete')) return 'DELETE';
    if (name.includes('patch')) return 'PATCH';
    return null;
  }

  private static extractPathFromGo(entity: any): string | null {
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

  private static extractMethodFromTypeScript(entity: any): string | null {
    return this.extractMethodFromGo(entity); // Same logic
  }

  private static extractPathFromTypeScript(entity: any): string | null {
    return this.extractPathFromGo(entity); // Same logic
  }

  private static extractMethodFromPython(entity: any): string | null {
    return this.extractMethodFromGo(entity); // Same logic
  }

  private static extractPathFromPython(entity: any): string | null {
    return this.extractPathFromGo(entity); // Same logic
  }

  private static extractCallMethodFromTypeScript(entity: any): string | null {
    return this.extractMethodFromGo(entity); // Same logic
  }

  private static extractUrlFromTypeScript(entity: any): string | null {
    // Extract from function name or purpose
    return this.extractPathFromGo(entity);
  }

  private static extractCallMethodFromGo(entity: any): string | null {
    return this.extractMethodFromGo(entity); // Same logic
  }

  private static extractUrlFromGo(entity: any): string | null {
    return this.extractPathFromGo(entity); // Same logic
  }
}
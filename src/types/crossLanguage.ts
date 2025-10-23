/**
 * Cross-Language Types for Enhanced Multi-Language Code Analysis
 * Extends the existing types to support polyglot projects
 */

import { FunctionMetadata, ComponentMetadata, EnhancedFunctionMetadata } from '../types.js';

/**
 * Core cross-language entity that can represent functions, classes, interfaces, etc.
 * across multiple programming languages
 */
export interface CrossLanguageEntity {
  // Core identification
  id: string;                             // Unique identifier across all languages
  name: string;                           // Entity name
  language: string;                       // Programming language
  file: string;                           // File path
  type: 'function' | 'class' | 'interface' | 'struct' | 'module' | 'component' | 'service' | 'endpoint';
  
  // Position information
  startLine?: number;
  endLine?: number;
  lineNumber?: number; // For compatibility with existing types
  
  // Language-specific metadata
  signature: string;                      // Full signature/declaration
  parameters: ParameterInfo[];            // Function/method parameters
  returnType?: string;                    // Return type if applicable
  visibility?: 'public' | 'private' | 'protected' | 'internal' | 'package';
  
  // Cross-language references
  calls: CrossReference[];               // What this entity calls
  calledBy: CrossReference[];            // What calls this entity
  implements?: string[];                 // Interfaces/contracts it implements
  implementedBy?: string[];              // Implementations of this interface
  extends?: string;                      // Parent class/interface
  extendedBy?: string[];                 // Child classes/interfaces
  
  // API contract information (for services/endpoints)
  apiEndpoint?: string;                  // REST/GraphQL endpoint
  apiMethod?: string;                    // HTTP method (GET, POST, etc.)
  apiContract?: APIContract;             // Expected request/response schema
  
  // Documentation and analysis
  purpose: string;                       // What this entity does
  context: string;                       // Context information
  jsDoc?: JSDocInfo;                     // Documentation
  
  // Search optimization
  searchTokens: string[];                // Tokenized for search
  importPath?: string;                   // How to import/reference this entity
  
  // Quality metrics
  complexity?: number;                   // Cyclomatic complexity
  testCoverage?: number;                 // Code coverage percentage
  
  // Metadata
  metadata?: Record<string, any>;        // Language-specific extra data
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Enhanced parameter information for cross-language support
 */
export interface ParameterInfo {
  name: string;
  type?: string;                         // Type annotation
  description?: string;                  // Documentation
  optional?: boolean;                    // Is parameter optional
  defaultValue?: string;                 // Default value if any
  constraints?: string[];                // Type constraints/generics
  isVariadic?: boolean;                  // Is this a variadic parameter (...args)
  language: string;                      // Language this parameter belongs to
}

/**
 * Cross-language reference between entities
 */
export interface CrossReference {
  sourceId: string;                      // Source entity ID
  targetId: string;                      // Target entity ID
  type: 'calls' | 'implements' | 'extends' | 'imports' | 'api-call' | 'grpc-call' | 'graphql-query';
  sourceLanguage: string;                // Language of source entity
  targetLanguage: string;                // Language of target entity
  confidence: number;                    // 0-1, confidence in this reference
  protocol?: 'http' | 'grpc' | 'graphql' | 'direct' | 'websocket';
  metadata?: {
    endpoint?: string;                   // API endpoint
    method?: string;                     // HTTP method or RPC method
    schema?: any;                        // Request/response schema
    line?: number;                       // Line where reference occurs
    column?: number;                     // Column where reference occurs
  };
}

/**
 * API contract definition for service interfaces
 */
export interface APIContract {
  version?: string;                      // API version
  request?: TypeSchema;                  // Request schema
  response?: TypeSchema;                 // Response schema
  errors?: ErrorSchema[];                // Possible error responses
  authentication?: AuthenticationSpec;   // Auth requirements
  rateLimit?: RateLimitSpec;            // Rate limiting info
  deprecated?: boolean;                  // Is this API deprecated
  deprecationDate?: Date;                // When it will be removed
  migration?: string;                    // Migration guide
}

/**
 * Type schema for API contracts
 */
export interface TypeSchema {
  type: string;                          // Base type (object, array, string, etc.)
  properties?: Record<string, TypeSchema>; // Object properties
  items?: TypeSchema;                    // Array item type
  required?: string[];                   // Required properties
  description?: string;                  // Schema description
  example?: any;                         // Example value
  constraints?: {
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    minimum?: number;
    maximum?: number;
  };
}

/**
 * Error schema for API contracts
 */
export interface ErrorSchema {
  code: string | number;                 // Error code
  message: string;                       // Error message template
  description?: string;                  // Detailed description
  schema?: TypeSchema;                   // Error response schema
  httpStatus?: number;                   // HTTP status code
}

/**
 * Authentication specification
 */
export interface AuthenticationSpec {
  type: 'bearer' | 'basic' | 'apikey' | 'oauth2' | 'custom';
  description?: string;                  // Auth description
  scopes?: string[];                     // Required scopes
  header?: string;                       // Header name for auth
}

/**
 * Rate limiting specification
 */
export interface RateLimitSpec {
  requests: number;                      // Number of requests
  window: string;                        // Time window (e.g., "1h", "1m")
  burst?: number;                        // Burst allowance
}

/**
 * Enhanced JSDoc information
 */
export interface JSDocInfo {
  description?: string;                  // Main description
  examples?: string[];                   // Code examples
  tags?: Record<string, string[]>;       // JSDoc tags
  params?: Record<string, string>;       // Parameter descriptions
  returns?: string;                      // Return value description
  throws?: string[];                     // Possible exceptions
  since?: string;                        // Version introduced
  deprecated?: string;                   // Deprecation info
  see?: string[];                        // See also references
}

/**
 * Language adapter interface for extracting entities
 */
export interface LanguageAdapter {
  language: string;
  extensions: string[];
  
  // Extract entities from source code
  extractEntities(filePath: string, content: string): Promise<CrossLanguageEntity[]>;
  
  // Parse and analyze a single file
  parseFile(filePath: string): Promise<{
    entities: CrossLanguageEntity[];
    dependencies: string[];
    exports: string[];
    imports: string[];
  }>;
  
  // Detect cross-references within the language
  detectReferences(entities: CrossLanguageEntity[]): Promise<CrossReference[]>;
  
  // Validate API contracts (if applicable)
  validateAPIContract?(entity: CrossLanguageEntity): Promise<APIContract | null>;
}

/**
 * Enhanced database document types
 */
export interface CrossLanguageEntityDocument extends CrossLanguageEntity {
  $loki?: number;
  meta?: any;
}

export interface CrossReferenceDocument extends CrossReference {
  $loki?: number;
  meta?: any;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface APIContractDocument extends APIContract {
  $loki?: number;
  meta?: any;
  entityId: string;                      // Associated entity ID
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Migration utilities for existing data
 */
export interface MigrationOptions {
  preserveExisting: boolean;             // Keep existing single-language data
  enhanceMetadata: boolean;              // Add cross-language metadata
  buildReferences: boolean;              // Build cross-references
  validateContracts: boolean;            // Validate API contracts
}

/**
 * Compatibility adapters for existing types
 */
export interface CompatibilityAdapter {
  // Convert existing FunctionMetadata to CrossLanguageEntity
  convertFunction(func: FunctionMetadata): CrossLanguageEntity;
  
  // Convert existing ComponentMetadata to CrossLanguageEntity
  convertComponent(comp: ComponentMetadata): CrossLanguageEntity;
  
  // Convert CrossLanguageEntity back to FunctionMetadata (for backward compatibility)
  toFunctionMetadata(entity: CrossLanguageEntity): FunctionMetadata;
  
  // Convert CrossLanguageEntity back to ComponentMetadata (for backward compatibility)
  toComponentMetadata(entity: CrossLanguageEntity): ComponentMetadata;
}

/**
 * Search and indexing types
 */
export interface CrossLanguageSearchOptions {
  languages?: string[];                  // Filter by languages
  types?: string[];                      // Filter by entity types
  includeReferences?: boolean;           // Include cross-references in results
  includeContracts?: boolean;            // Include API contracts
  confidenceThreshold?: number;          // Minimum confidence for references
}

export interface CrossLanguageSearchResult {
  entity: CrossLanguageEntity;
  score: number;                         // Search relevance score
  matches: string[];                     // Matched fields
  references?: CrossReference[];         // Related cross-references
  contracts?: APIContract[];             // Related API contracts
}

/**
 * Analysis and reporting types
 */
export interface CrossLanguageAnalysisResult {
  totalEntities: number;
  entitiesByLanguage: Record<string, number>;
  entitiesByType: Record<string, number>;
  crossReferences: number;
  apiContracts: number;
  orphanedEntities: string[];            // Entities with no references
  complexities: Record<string, number>;  // Average complexity by language
  coverage: Record<string, number>;      // Test coverage by language
}

export interface DependencyGraph {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  cycles: DependencyCycle[];             // Detected circular dependencies
  metrics: DependencyMetrics;
}

export interface DependencyNode {
  id: string;
  name: string;
  language: string;
  type: string;
  file: string;
  weight?: number;                       // Node importance
  cluster?: string;                      // Logical grouping
}

export interface DependencyEdge {
  from: string;
  to: string;
  type: string;
  weight?: number;                       // Edge strength
  protocol?: string;
}

export interface DependencyCycle {
  nodes: string[];                       // IDs of nodes in cycle
  severity: 'warning' | 'critical';     // Cycle severity
  suggestion?: string;                   // How to break the cycle
}

export interface DependencyMetrics {
  totalNodes: number;
  totalEdges: number;
  cycleCount: number;
  averageDepth: number;
  maxDepth: number;
  stronglyConnectedComponents: number;
}
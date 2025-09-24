import { ParsedQuery } from '../types';

/**
 * QueryParser - Parses search queries into structured format with tokenization and synonym expansion
 * 
 * Supports:
 * - Multi-word queries with intelligent tokenization
 * - Exact phrase matching with quotes
 * - Excluded terms with minus operator
 * - Special operators (type:, param:, return:, etc.)
 * - Synonym expansion for common programming terms
 * - Fuzzy search and stemming flags
 */
export class QueryParser {
  // Comprehensive synonym mappings for programming terms
  private static readonly SYNONYMS: Record<string, string[]> = {
    // Common programming verbs
    'get': ['fetch', 'retrieve', 'obtain', 'find', 'query', 'load', 'read'],
    'set': ['update', 'save', 'store', 'write', 'assign', 'modify', 'change'],
    'create': ['make', 'new', 'generate', 'build', 'construct', 'initialize', 'init'],
    'delete': ['remove', 'destroy', 'drop', 'clear', 'purge', 'erase'],
    'add': ['append', 'insert', 'push', 'attach', 'include'],
    'remove': ['delete', 'pop', 'detach', 'exclude', 'eliminate'],
    
    // Data structures
    'array': ['list', 'vector', 'collection', 'arr'],
    'object': ['obj', 'dict', 'dictionary', 'map', 'hash', 'record'],
    'string': ['str', 'text', 'chars', 'characters'],
    'number': ['num', 'int', 'integer', 'float', 'double', 'numeric'],
    'boolean': ['bool', 'flag', 'true/false'],
    
    // Common patterns
    'validate': ['check', 'verify', 'test', 'ensure', 'confirm'],
    'handler': ['listener', 'callback', 'processor', 'controller'],
    'util': ['utility', 'helper', 'tools', 'utils'],
    'config': ['configuration', 'settings', 'options', 'conf'],
    'auth': ['authentication', 'authorization', 'authenticate', 'authorize'],
    'user': ['users', 'person', 'account', 'member', 'client'],
    'error': ['err', 'exception', 'fault', 'failure', 'problem'],
    'log': ['logger', 'logging', 'trace', 'debug', 'console'],
    
    // HTTP/API related
    'api': ['endpoint', 'route', 'service', 'rest', 'graphql'],
    'request': ['req', 'http', 'call', 'fetch'],
    'response': ['res', 'reply', 'result', 'output'],
    
    // Database related
    'database': ['db', 'storage', 'datastore', 'repository'],
    'query': ['sql', 'search', 'find', 'select'],
    'table': ['collection', 'entity', 'model', 'schema'],
    
    // React/Frontend specific
    'component': ['comp', 'widget', 'element', 'view', 'react', 'ui'],
    'render': ['display', 'show', 'present', 'draw', 'renders', 'paint'],
    'state': ['status', 'data', 'store', 'context'],
    'props': ['properties', 'attributes', 'params', 'arguments'],
    
    // Async patterns
    'async': ['asynchronous', 'promise', 'await', 'concurrent'],
    'sync': ['synchronous', 'blocking', 'sequential'],
    'callback': ['cb', 'handler', 'listener', 'oncomplete'],
    
    // Testing
    'test': ['tests', 'spec', 'suite', 'unit', 'integration', 'e2e'],
    'mock': ['stub', 'fake', 'spy', 'double'],
    
    // Common abbreviations
    'fn': ['function', 'func', 'method'],
    'param': ['parameter', 'arg', 'argument'],
    'return': ['returns', 'output', 'result'],
    'doc': ['documentation', 'docs', 'comment', 'jsdoc'],
    
    // React-specific (additional)
    'hook': ['hooks', 'useeffect', 'usestate', 'usememo', 'usecallback'],
    'jsx': ['tsx', 'react-element', 'markup'],
    'lifecycle': ['mount', 'unmount', 'update', 'effect']
  };

  // Special operators that can be used in queries
  private static readonly OPERATORS = {
    'type:': 'fileType',
    'file:': 'filePath',
    'path:': 'filePath',
    'lang:': 'language',
    'language:': 'language',
    'param:': 'parameters',
    'parameter:': 'parameters',
    'return:': 'returnType',
    'returns:': 'returnType',
    'complexity:': 'complexity',
    'jsdoc:': 'hasJsDoc',
    'doc:': 'hasJsDoc',
    'since:': 'dateRange',
    'before:': 'dateRange',
    'after:': 'dateRange',
    // React-specific operators
    'component:': 'componentType',
    'hook:': 'hasHook',
    'hooks:': 'hasHook',
    'prop:': 'hasProp',
    'props:': 'hasProp',
    'entity:': 'entityType',
    // Dependency operators
    'dep:': 'usesDependency',
    'dependency:': 'usesDependency',
    'uses:': 'usesDependency',
    'calls:': 'callsFunction',
    'calledby:': 'calledByFunction',
    'dependents-of:': 'calledByFunction',
    'used-by:': 'calledByFunction',
    'depends-on:': 'dependsOnModule',
    'imports-from:': 'dependsOnModule',
    'unused-imports': 'hasUnusedImports',
    'dead-imports': 'hasUnusedImports'
  } as const;

  /**
   * Parse a search query string into a structured ParsedQuery object
   * @param query The raw search query string
   * @returns ParsedQuery object with extracted terms, filters, and options
   */
  public parse(query: string): ParsedQuery {
    const result: ParsedQuery = {
      terms: [],
      originalTerms: [],
      phrases: [],
      excludedTerms: [],
      filters: {},
      searchFields: undefined,
      fuzzy: false,
      stemming: false
    };

    if (!query || query.trim().length === 0) {
      return result;
    }

    // Extract operators and their values first (before phrases)
    // This ensures operator:value patterns are processed correctly
    const { operators, cleanedQuery } = this.extractOperators(query);
    this.applyOperatorFilters(operators, result);

    // Extract exact phrases (quoted strings) from the cleaned query
    const phrases = this.extractPhrases(cleanedQuery);
    result.phrases = phrases.map(p => p.value);
    
    // Remove phrases from cleaned query for further processing
    let remainingQuery = cleanedQuery;
    phrases.forEach(phrase => {
      remainingQuery = remainingQuery.replace(phrase.original, ' ');
    });

    // Process remaining tokens
    const tokens = this.tokenize(remainingQuery);
    
    for (const token of tokens) {
      if (token.startsWith('-')) {
        // Excluded term
        const term = token.slice(1);
        if (term.length > 0) {
          result.excludedTerms.push(term);
          // Also add synonyms to excluded terms
          const synonyms = this.getSynonyms(term);
          result.excludedTerms.push(...synonyms);
        }
      } else if (token === '~' || token === 'fuzzy') {
        // Enable fuzzy search
        result.fuzzy = true;
      } else if (token === 'stem' || token === 'stemming') {
        // Enable stemming
        result.stemming = true;
      } else if (token === 'unused-imports' || token === 'dead-imports') {
        // Special operators without colons
        if (!result.filters.metadata) {
          result.filters.metadata = {};
        }
        result.filters.metadata.hasUnusedImports = true;
      } else {
        // Regular search term
        result.originalTerms!.push(token);
        result.terms.push(token);
        // Add synonyms for the term
        const synonyms = this.getSynonyms(token);
        result.terms.push(...synonyms);
      }
    }

    // Remove duplicates
    result.originalTerms = [...new Set(result.originalTerms!)];
    result.terms = [...new Set(result.terms)];
    result.excludedTerms = [...new Set(result.excludedTerms)];
    result.phrases = [...new Set(result.phrases)];

    // Set default search fields if not specified
    if (!result.searchFields || result.searchFields.length === 0) {
      result.searchFields = ['name', 'signature', 'jsDoc', 'purpose', 'context'];
    }

    return result;
  }

  /**
   * Extract quoted phrases from the query
   * Handles nested quotes and escape sequences
   * @param query The query string
   * @returns Array of phrase objects with original and cleaned value
   */
  private extractPhrases(query: string): Array<{ original: string; value: string }> {
    const phrases: Array<{ original: string; value: string }> = [];
    let i = 0;
    
    while (i < query.length) {
      // Find opening quote (single or double)
      if (query[i] === '"' || query[i] === "'") {
        const quoteChar = query[i];
        const startIndex = i;
        i++; // Move past opening quote
        
        let value = '';
        let closed = false;
        
        while (i < query.length) {
          if (query[i] === '\\' && i + 1 < query.length) {
            // Handle escape sequences
            if (query[i + 1] === quoteChar || query[i + 1] === '\\') {
              // Escaped quote or backslash
              value += query[i + 1];
              i += 2;
            } else {
              // Other escape sequences - keep the backslash
              value += query[i];
              i++;
            }
          } else if (query[i] === quoteChar) {
            // Found closing quote
            closed = true;
            i++; // Move past closing quote
            break;
          } else {
            // Regular character
            value += query[i];
            i++;
          }
        }
        
        if (closed) {
          phrases.push({
            original: query.substring(startIndex, i),
            value: value.trim()
          });
        } else {
          // Unclosed quote - treat the rest as a phrase
          phrases.push({
            original: query.substring(startIndex),
            value: value.trim()
          });
        }
      } else {
        i++;
      }
    }
    
    return phrases;
  }

  /**
   * Extract operators and their values from the query
   * Handles quoted values and escape sequences
   * @param query The query string
   * @returns Object with operators map and cleaned query
   */
  private extractOperators(query: string): { 
    operators: Map<string, string>; 
    cleanedQuery: string 
  } {
    const operators = new Map<string, string>();
    let cleanedQuery = query;
    let i = 0;
    
    while (i < query.length) {
      // Look for operator:value patterns
      const operatorMatch = query.substring(i).match(/^(\w+):/);
      
      if (operatorMatch) {
        const operator = operatorMatch[1].toLowerCase() + ':';
        const operatorEndIndex = i + operatorMatch[0].length;
        
        if (operator in QueryParser.OPERATORS) {
          // Extract the value after the operator
          let valueStartIndex = operatorEndIndex;
          let value = '';
          let valueEndIndex = valueStartIndex;
          
          if (valueStartIndex < query.length) {
            const nextChar = query[valueStartIndex];
            
            if (nextChar === '"' || nextChar === "'") {
              // Quoted value - extract using quote handling logic
              const quoteChar = nextChar;
              valueStartIndex++; // Move past opening quote
              let j = valueStartIndex;
              
              while (j < query.length) {
                if (query[j] === '\\' && j + 1 < query.length) {
                  // Handle escape sequences
                  if (query[j + 1] === quoteChar || query[j + 1] === '\\') {
                    value += query[j + 1];
                    j += 2;
                  } else {
                    value += query[j];
                    j++;
                  }
                } else if (query[j] === quoteChar) {
                  // Found closing quote
                  j++; // Move past closing quote
                  valueEndIndex = j;
                  break;
                } else {
                  value += query[j];
                  j++;
                }
              }
              
              if (valueEndIndex === valueStartIndex) {
                // Unclosed quote - take rest of query
                value = query.substring(valueStartIndex);
                valueEndIndex = query.length;
              }
            } else {
              // Unquoted value - take until whitespace or next operator
              let j = valueStartIndex;
              while (j < query.length && !query[j].match(/\s/) && !query.substring(j).match(/^\w+:/)) {
                value += query[j];
                j++;
              }
              valueEndIndex = j;
            }
          }
          
          if (value) {
            operators.set(operator, value);
            // Replace the operator:value with spaces to clean the query
            const toReplace = query.substring(i, valueEndIndex);
            cleanedQuery = cleanedQuery.replace(toReplace, ' '.repeat(toReplace.length));
          }
          
          i = valueEndIndex;
        } else {
          i++;
        }
      } else {
        i++;
      }
    }

    return { operators, cleanedQuery: cleanedQuery.trim().replace(/\s+/g, ' ') };
  }

  /**
   * Apply operator filters to the parsed query
   * @param operators Map of operators and values
   * @param parsedQuery The parsed query object to update
   */
  private applyOperatorFilters(
    operators: Map<string, string>, 
    parsedQuery: ParsedQuery
  ): void {
    operators.forEach((value, operator) => {
      const filterKey = QueryParser.OPERATORS[operator as keyof typeof QueryParser.OPERATORS];
      
      switch (filterKey) {
        case 'fileType':
          parsedQuery.filters.fileType = value;
          break;
          
        case 'filePath':
          parsedQuery.filters.filePath = value;
          break;
          
        case 'language':
          parsedQuery.filters.language = value;
          break;
          
        case 'hasJsDoc':
          parsedQuery.filters.hasJsDoc = value.toLowerCase() === 'true' || value === '1';
          break;
          
        case 'complexity':
          if (value.includes('-')) {
            const [min, max] = value.split('-').map(v => parseInt(v.trim(), 10));
            if (!isNaN(min) && !isNaN(max)) {
              parsedQuery.filters.complexity = { min, max };
            }
          } else {
            const complexityValue = parseInt(value, 10);
            if (!isNaN(complexityValue)) {
              parsedQuery.filters.complexity = {
                min: complexityValue,
                max: complexityValue
              };
            }
          }
          break;
          
        case 'dateRange':
          if (!parsedQuery.filters.dateRange) {
            parsedQuery.filters.dateRange = {};
          }
          const date = new Date(value);
          if (!isNaN(date.getTime())) {
            if (operator === 'since:' || operator === 'after:') {
              parsedQuery.filters.dateRange.start = date;
            } else if (operator === 'before:') {
              parsedQuery.filters.dateRange.end = date;
            }
          }
          break;
          
        case 'parameters':
          // Add parameter search to search fields
          if (!parsedQuery.searchFields) {
            parsedQuery.searchFields = [];
          }
          parsedQuery.searchFields.push('parameters');
          parsedQuery.terms.push(value);
          break;
          
        case 'returnType':
          // Add return type to search fields
          if (!parsedQuery.searchFields) {
            parsedQuery.searchFields = [];
          }
          parsedQuery.searchFields.push('returnType');
          parsedQuery.terms.push(value);
          break;
          
        case 'componentType':
          // Filter by React component type
          if (!parsedQuery.filters.metadata) {
            parsedQuery.filters.metadata = {};
          }
          parsedQuery.filters.metadata.componentType = value;
          break;
          
        case 'hasHook':
          // Search for components using specific hooks
          if (!parsedQuery.filters.metadata) {
            parsedQuery.filters.metadata = {};
          }
          parsedQuery.filters.metadata.hasHook = value;
          break;
          
        case 'hasProp':
          // Search for components with specific props
          if (!parsedQuery.filters.metadata) {
            parsedQuery.filters.metadata = {};
          }
          parsedQuery.filters.metadata.hasProp = value;
          break;
          
        case 'entityType':
          // Filter by entity type (function vs component)
          if (!parsedQuery.filters.metadata) {
            parsedQuery.filters.metadata = {};
          }
          parsedQuery.filters.metadata.entityType = value;
          break;
          
        case 'usesDependency':
          // Filter by external dependency usage
          if (!parsedQuery.filters.metadata) {
            parsedQuery.filters.metadata = {};
          }
          parsedQuery.filters.metadata.usesDependency = value;
          break;
          
        case 'callsFunction':
          // Filter by functions that this function calls
          if (!parsedQuery.filters.metadata) {
            parsedQuery.filters.metadata = {};
          }
          parsedQuery.filters.metadata.callsFunction = value;
          break;
          
        case 'calledByFunction':
          // Filter by functions that call this function
          if (!parsedQuery.filters.metadata) {
            parsedQuery.filters.metadata = {};
          }
          parsedQuery.filters.metadata.calledByFunction = value;
          break;
          
        case 'dependsOnModule':
          // Filter by module/file dependencies
          if (!parsedQuery.filters.metadata) {
            parsedQuery.filters.metadata = {};
          }
          parsedQuery.filters.metadata.dependsOnModule = value;
          break;
          
        case 'hasUnusedImports':
          // Special filter for unused imports (boolean)
          if (!parsedQuery.filters.metadata) {
            parsedQuery.filters.metadata = {};
          }
          parsedQuery.filters.metadata.hasUnusedImports = true;
          break;
      }
    });
  }

  /**
   * Tokenize a string into individual words
   * @param text The text to tokenize
   * @returns Array of tokens
   */
  private tokenize(text: string): string[] {
    // Split on whitespace and common delimiters, but preserve hyphenated words
    const tokens = text
      .toLowerCase()
      .split(/\s+/)
      .filter(token => token.length > 0);
    
    // Further split camelCase and snake_case
    const expandedTokens: string[] = [];
    
    for (const token of tokens) {
      // Split camelCase
      const camelCaseTokens = token.split(/(?=[A-Z])/).filter(t => t.length > 0);
      if (camelCaseTokens.length > 1) {
        expandedTokens.push(token); // Keep original
        expandedTokens.push(...camelCaseTokens.map(t => t.toLowerCase()));
      } else {
        // Split snake_case
        const snakeCaseTokens = token.split('_').filter(t => t.length > 0);
        if (snakeCaseTokens.length > 1) {
          expandedTokens.push(token); // Keep original
          expandedTokens.push(...snakeCaseTokens);
        } else {
          expandedTokens.push(token);
        }
      }
    }
    
    return [...new Set(expandedTokens)];
  }

  /**
   * Get synonyms for a given term
   * @param term The term to find synonyms for
   * @returns Array of synonyms (not including the original term)
   */
  public getSynonyms(term: string): string[] {
    const synonyms: string[] = [];
    const lowerTerm = term.toLowerCase();
    
    // Check if term is a direct key
    if (QueryParser.SYNONYMS[lowerTerm]) {
      synonyms.push(...QueryParser.SYNONYMS[lowerTerm]);
    }
    
    // Check if term is a value in any synonym group
    for (const [key, values] of Object.entries(QueryParser.SYNONYMS)) {
      if (values.includes(lowerTerm)) {
        synonyms.push(key);
        // Add other synonyms from the same group
        synonyms.push(...values.filter(v => v !== lowerTerm));
      }
    }
    
    return [...new Set(synonyms)];
  }

  /**
   * Expand a query with synonyms (utility method)
   * @param query The original query
   * @returns Expanded query with synonyms
   */
  public expandQuery(query: string): string {
    const parsed = this.parse(query);
    const allTerms = [...new Set([...parsed.terms, ...parsed.phrases])];
    return allTerms.join(' ');
  }
}

// Export a singleton instance for convenience
export const queryParser = new QueryParser();
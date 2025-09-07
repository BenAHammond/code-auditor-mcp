import { QueryParser } from './QueryParser';
import { ParsedQuery } from '../types';

describe('QueryParser', () => {
  let parser: QueryParser;

  beforeEach(() => {
    parser = new QueryParser();
  });

  describe('Basic Query Parsing', () => {
    it('should handle empty queries', () => {
      const result = parser.parse('');
      expect(result.terms).toEqual([]);
      expect(result.phrases).toEqual([]);
      expect(result.excludedTerms).toEqual([]);
    });

    it('should parse simple terms', () => {
      const result = parser.parse('get user data');
      expect(result.terms).toContain('get');
      expect(result.terms).toContain('user');
      expect(result.terms).toContain('data');
    });

    it('should parse exact phrases', () => {
      const result = parser.parse('"user authentication" validate');
      expect(result.phrases).toContain('user authentication');
      expect(result.terms).toContain('validate');
    });

    it('should handle excluded terms', () => {
      const result = parser.parse('authentication -login -password');
      expect(result.terms).toContain('authentication');
      expect(result.excludedTerms).toContain('login');
      expect(result.excludedTerms).toContain('password');
    });
  });

  describe('Synonym Expansion', () => {
    it('should expand get synonyms', () => {
      const result = parser.parse('get');
      expect(result.terms).toContain('fetch');
      expect(result.terms).toContain('retrieve');
      expect(result.terms).toContain('find');
      expect(result.terms).toContain('query');
    });

    it('should expand array synonyms', () => {
      const result = parser.parse('array');
      expect(result.terms).toContain('list');
      expect(result.terms).toContain('vector');
      expect(result.terms).toContain('collection');
    });

    it('should expand auth synonyms', () => {
      const result = parser.parse('auth');
      expect(result.terms).toContain('authentication');
      expect(result.terms).toContain('authorization');
    });

    it('should expand synonyms in excluded terms', () => {
      const result = parser.parse('user -auth');
      expect(result.excludedTerms).toContain('auth');
      expect(result.excludedTerms).toContain('authentication');
      expect(result.excludedTerms).toContain('authorization');
    });
  });

  describe('Special Operators', () => {
    it('should parse file type operator', () => {
      const result = parser.parse('type:tsx react component');
      expect(result.filters.fileType).toBe('tsx');
      expect(result.terms).toContain('react');
      expect(result.terms).toContain('component');
    });

    it('should parse file path operator', () => {
      const result = parser.parse('file:components/Button.tsx');
      expect(result.filters.filePath).toBe('components/Button.tsx');
    });

    it('should parse language operator', () => {
      const result = parser.parse('lang:typescript function');
      expect(result.filters.language).toBe('typescript');
    });

    it('should parse JSDoc operator', () => {
      const result = parser.parse('jsdoc:true documented functions');
      expect(result.filters.hasJsDoc).toBe(true);
    });

    it('should parse complexity operator with single value', () => {
      const result = parser.parse('complexity:5 simple functions');
      expect(result.filters.complexity).toEqual({ min: 5, max: 5 });
    });

    it('should parse complexity operator with range', () => {
      const result = parser.parse('complexity:5-10 moderate functions');
      expect(result.filters.complexity).toEqual({ min: 5, max: 10 });
    });

    it('should parse date operators', () => {
      const result = parser.parse('since:2024-01-01 new functions');
      expect(result.filters.dateRange?.start).toEqual(new Date('2024-01-01'));
    });

    it('should parse parameter operator', () => {
      const result = parser.parse('param:userId user functions');
      expect(result.searchFields).toContain('parameters');
      expect(result.terms).toContain('userId');
    });

    it('should parse return type operator', () => {
      const result = parser.parse('return:Promise async functions');
      expect(result.searchFields).toContain('returnType');
      expect(result.terms).toContain('Promise');
    });
  });

  describe('Complex Queries', () => {
    it('should handle multiple operators and terms', () => {
      const result = parser.parse('type:ts lang:typescript "user service" -deprecated complexity:1-5');
      expect(result.filters.fileType).toBe('ts');
      expect(result.filters.language).toBe('typescript');
      expect(result.phrases).toContain('user service');
      expect(result.excludedTerms).toContain('deprecated');
      expect(result.filters.complexity).toEqual({ min: 1, max: 5 });
    });

    it('should handle fuzzy search flag', () => {
      const result = parser.parse('authentication ~ fuzzy');
      expect(result.fuzzy).toBe(true);
      expect(result.terms).toContain('authentication');
    });

    it('should handle stemming flag', () => {
      const result = parser.parse('validate validation stemming');
      expect(result.stemming).toBe(true);
    });
  });

  describe('Tokenization', () => {
    it('should split camelCase terms', () => {
      const result = parser.parse('getUserData');
      expect(result.terms).toContain('getUserData');
      expect(result.terms).toContain('get');
      expect(result.terms).toContain('user');
      expect(result.terms).toContain('data');
    });

    it('should split snake_case terms', () => {
      const result = parser.parse('get_user_data');
      expect(result.terms).toContain('get_user_data');
      expect(result.terms).toContain('get');
      expect(result.terms).toContain('user');
      expect(result.terms).toContain('data');
    });
  });

  describe('Default Search Fields', () => {
    it('should set default search fields when not specified', () => {
      const result = parser.parse('user data');
      expect(result.searchFields).toEqual(['name', 'signature', 'jsDoc', 'purpose', 'context']);
    });
  });

  describe('Query Expansion Utility', () => {
    it('should expand query with all synonyms', () => {
      const expanded = parser.expandQuery('get user');
      expect(expanded).toContain('get');
      expect(expanded).toContain('fetch');
      expect(expanded).toContain('retrieve');
      expect(expanded).toContain('user');
      expect(expanded).toContain('users');
    });
  });
});

// Example usage demonstrations
function demonstrateQueryParser() {
  const parser = new QueryParser();
  
  // Simple query
  console.log('Simple query:', parser.parse('get user data'));
  
  // Query with exact phrase
  console.log('Exact phrase:', parser.parse('"user authentication" service'));
  
  // Query with operators
  console.log('With operators:', parser.parse('type:ts lang:typescript auth -deprecated'));
  
  // Complex query
  console.log('Complex query:', parser.parse(
    'type:tsx "react component" get state -deprecated complexity:1-10 jsdoc:true fuzzy'
  ));
  
  // Query with parameter search
  console.log('Parameter search:', parser.parse('param:userId getUserById'));
  
  // Query with date filter
  console.log('Date filter:', parser.parse('since:2024-01-01 new features'));
}
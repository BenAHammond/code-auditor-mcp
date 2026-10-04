/**
 * Search access — FTS5 + operator query compilation and the in-memory filter
 * fallback. Extracted from `CodeIndexDB`; holds the SQLite handle plus the
 * `FunctionIndex` it marshals result rows through (row → function document).
 * The cross-concern `searchWithSchemaContext` (search + schema usage) stays on
 * the facade because it composes two modules.
 */

import type { SqliteDatabase } from '../sqlite/types.js';
import { QueryParser, compileToSQL, type SqlQuery } from '../search/QueryParser.js';
import { tryParseJson, escapeRegExpLiteral } from './shared.js';
import { FunctionIndex } from './functionIndex.js';
import type {
  EnhancedFunctionMetadata,
  SearchResult,
  SearchOptions,
  ParsedQuery,
} from '../types.js';

/** A function row marshalled for search results, with an optional Loki id. */
interface FunctionDocument extends EnhancedFunctionMetadata {
  $loki?: number;
  meta?: any;
}

/**
 * Apply the metadata facet of a search filter to a single function document.
 * Returns true when the document satisfies every populated metadata facet
 * (entity/component type, hook/prop substring, dependency/caller/callee/module
 * substrings, unused-import presence). Extracted from `applyFilters` to keep
 * that method's cyclomatic complexity under the method-complexity ceiling.
 */
function matchesMetadataFilter(
  doc: FunctionDocument,
  m: NonNullable<NonNullable<SearchOptions['filters']>['metadata']>
): boolean {
  if (!doc.metadata) return false;
  if (m.entityType && doc.metadata.entityType !== m.entityType) return false;
  if (m.componentType && doc.metadata.componentType !== m.componentType) return false;
  if (m.hasHook) {
    if (!doc.metadata.hooks) return false;
    const found = (doc.metadata.hooks as any[]).some((h: any) =>
      h.name?.toLowerCase().includes(m.hasHook!.toLowerCase()));
    if (!found) return false;
  }
  if (m.hasProp) {
    if (!doc.metadata.props) return false;
    const found = (doc.metadata.props as any[]).some((p: any) =>
      p.name?.toLowerCase().includes(m.hasProp!.toLowerCase()));
    if (!found) return false;
  }
  if (m.usesDependency) {
    const dep = m.usesDependency.toLowerCase();
    const inFile = doc.dependencies.some(d => d.toLowerCase().includes(dep));
    const inFunc = (doc.metadata.usedImports as string[] | undefined)?.some(i => i.toLowerCase().includes(dep)) ?? false;
    if (!inFile && !inFunc) return false;
  }
  if (m.callsFunction) {
    const target = m.callsFunction.toLowerCase();
    const calls = doc.metadata.functionCalls as string[] | undefined;
    if (!calls || !calls.some(c => c.toLowerCase().includes(target))) return false;
  }
  if (m.calledByFunction) {
    const caller = m.calledByFunction.toLowerCase();
    const calledBy = doc.metadata.calledBy as string[] | undefined;
    if (!calledBy || !calledBy.some(c => c.toLowerCase().includes(caller))) return false;
  }
  if (m.dependsOnModule) {
    const mod = m.dependsOnModule.toLowerCase();
    const inFile2 = doc.filePath.toLowerCase().includes(mod);
    const inDep = doc.dependencies.some(d => d.toLowerCase().includes(mod));
    const inCall = (doc.metadata.functionCalls as string[] | undefined)?.some(c => c.toLowerCase().includes(mod)) ?? false;
    if (!inFile2 && !inDep && !inCall) return false;
  }
  if (m.hasUnusedImports) {
    const unused = doc.metadata.unusedImports as any[] | undefined;
    if (!unused || unused.length === 0) return false;
  }
  return true;
}

/**
 * Full-text and operator search over the functions table. Compiles parsed
 * queries to SQL (FTS5 when a match term exists) and falls back to in-memory
 * filtering otherwise, marshalling rows through FunctionIndex into documents.
 */
export class SearchIndex {
  /**
   * Create the search index over the shared handle.
   *
   * @param db The SQLite database handle.
   * @param functionIndex The function index used to map rows to documents.
   */
  constructor(private db: SqliteDatabase, private functionIndex: FunctionIndex) {}

  /**
   * Search indexed functions via the query parser, using the FTS5 SQL path when
   * a parsed query is available and falling back to in-memory filtering otherwise.
   *
   * @param options - Search options including query, filters, limit, and offset.
   * @returns The search result with matching functions and total count.
   */
  async searchFunctions(options: SearchOptions): Promise<SearchResult> {
    const startTime = Date.now();

    const queryParser = new QueryParser();
    let parsedQuery: ParsedQuery | undefined;

    if (options.query) {
      parsedQuery = options.parsedQuery || queryParser.parse(options.query);
    } else if (options.parsedQuery) {
      parsedQuery = options.parsedQuery;
    }

    // If there's a parsed query, use the SQL path (handles both FTS5 and operator-only queries)
    if (parsedQuery) {
      const compiled = compileToSQL(parsedQuery, { defaultLimit: options.limit || 50, offset: options.offset || 0 });
      return this.executeCompiledSearch(compiled, parsedQuery, options, startTime);
    }

    // Otherwise, get all functions and apply filters in-memory (backward compatible)
    const rows = this.db.prepare('SELECT *, rowid as "$loki" FROM functions').all() as any[];
    let results: FunctionDocument[] = rows.map((r: any) => this.rowToFunctionDoc(r));

    // Apply filters (parsedQuery is undefined here — the if-parsedQuery branch returned early)
    const combinedFilters = this.mergeFilters(options.filters, undefined);
    results = this.applyFilters(results, combinedFilters);

    const totalCount = results.length;
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    results = results.slice(offset, offset + limit);

    const functions = results.map(doc => ({
      ...doc,
      score: 50
    })) as Array<EnhancedFunctionMetadata & { score: number }>;

    return {
      functions,
      totalCount,
      query: options.query,
      parsedQuery,
      executionTime: Date.now() - startTime
    };
  }

  private executeCompiledSearch(
    compiled: SqlQuery,
    parsedQuery: ParsedQuery,
    options: SearchOptions,
    startTime: number
  ): SearchResult {
    let sql: string;
    const params: Record<string, any> = { ...compiled.params };

    let afterFrom = '';

    // Collect JOINs first — they must precede WHERE in SQL
    for (const join of compiled.joinClauses) {
      afterFrom += ` ${join}`;
    }

    if (compiled.ftsMatch) {
      // FTS5 path
      sql = `SELECT f.*, f.rowid as "$loki", bm25(functions_fts) as score
        FROM functions f
        JOIN functions_fts ON functions_fts.rowid = f.id${afterFrom}
        WHERE functions_fts MATCH @_ftsMatch`;
      params['_ftsMatch'] = compiled.ftsMatch;
    } else {
      sql = `SELECT f.*, f.rowid as "$loki", 0 as score FROM functions f${afterFrom} WHERE 1=1`;
    }

    // Add WHERE clauses
    for (const clause of compiled.whereClauses) {
      sql += ` AND (${clause})`;
    }

    // Ordering
    sql += ` ORDER BY ${compiled.orderBy}`;

    // Limit/offset
    sql += ` LIMIT ${compiled.limit} OFFSET ${compiled.offset}`;

    const rows = this.db.prepare(sql).all(params) as any[];

    // Get total count (without limit)
    let totalCount = rows.length;
    try {
      let countSql: string;
      let countAfterFrom = '';
      for (const join of compiled.joinClauses) {
        countAfterFrom += ` ${join}`;
      }
      if (compiled.ftsMatch) {
        countSql = `SELECT COUNT(*) as cnt FROM functions f
          JOIN functions_fts ON functions_fts.rowid = f.id${countAfterFrom}
          WHERE functions_fts MATCH @_ftsMatch`;
      } else {
        countSql = `SELECT COUNT(*) as cnt FROM functions f${countAfterFrom} WHERE 1=1`;
      }
      for (const clause of compiled.whereClauses) {
        countSql += ` AND (${clause})`;
      }
      const countParams = { ...params };
      delete countParams['_ftsMatch'];
      if (compiled.ftsMatch) {
        countParams['_ftsMatch'] = compiled.ftsMatch;
      }
      const countResult = this.db.prepare(countSql).get(countParams) as any;
      totalCount = countResult?.cnt ?? rows.length;
    } catch {
      // Fall back to results length
    }

    // Convert rows to FunctionDocument, applying excluded terms
    let docs = rows.map((r: any) => this.rowToFunctionDoc(r));

    if (parsedQuery.excludedTerms.length > 0) {
      docs = this.excludeTermsFromResults(docs, parsedQuery.excludedTerms);
    }

    // Apply in-memory filters (for filters not handled by compileToSQL)
    const combinedFilters = this.mergeFilters(options.filters, parsedQuery.filters);
    docs = this.applyFilters(docs, combinedFilters);

    const functions = docs.map(doc => ({
      ...doc,
      score: (doc as any).score ?? 0
    })) as Array<EnhancedFunctionMetadata & { score: number }>;

    return {
      functions,
      totalCount,
      query: options.query,
      parsedQuery,
      executionTime: Date.now() - startTime
    };
  }

  private rowToFunctionDoc(row: any): FunctionDocument {
    const func = this.functionIndex.rowToFunction(row);
    const doc: FunctionDocument = {
      ...func,
      $loki: row['$loki'] ?? row.id,
      dependencies: [],
    };
    // Populate dependencies from metadata
    const meta = tryParseJson(row.metadata_json);
    if (meta) {
      // Include both specifier-level (usedImports) and module-level (dependencies)
      const usedImports: string[] = meta.usedImports ?? [];
      const moduleDeps: string[] = meta.dependencies ?? [];
      doc.dependencies = [...new Set([...usedImports, ...moduleDeps])];
    }
    return doc;
  }

  private mergeFilters(
    optionsFilters?: SearchOptions['filters'],
    queryFilters?: ParsedQuery['filters']
  ): SearchOptions['filters'] {
    const merged: SearchOptions['filters'] = {};
    if (optionsFilters) Object.assign(merged, optionsFilters);
    if (queryFilters) {
      if (queryFilters.language) merged.language = queryFilters.language;
      if (queryFilters.filePath) merged.filePath = queryFilters.filePath;
      if (queryFilters.fileType) merged.fileType = queryFilters.fileType;
      if (queryFilters.hasJsDoc !== undefined) merged.hasJsDoc = queryFilters.hasJsDoc;
      if (queryFilters.complexity) merged.complexity = queryFilters.complexity;
      if (queryFilters.dateRange) merged.dateRange = queryFilters.dateRange;
      if (queryFilters.metadata) merged.metadata = queryFilters.metadata;
    }
    return merged;
  }

  private applyFilters(
    results: FunctionDocument[],
    filters?: SearchOptions['filters']
  ): FunctionDocument[] {
    if (!filters) return results;
    let filtered = results;

    if (filters.language) {
      filtered = filtered.filter(doc => doc.language === filters.language);
    }
    if (filters.filePath) {
      if (filters.filePath.includes('*') || filters.filePath.includes('?')) {
        // `*` and `?` are the only glob wildcards; every other character is
        // escaped so it matches literally. A path like `foo[0-9].ts` no longer
        // becomes an accidental regex character class.
        const pattern = filters.filePath
          .split(/([*?])/)
          .map((seg) => (seg === '*' ? '.*' : seg === '?' ? '.' : escapeRegExpLiteral(seg)))
          .join('');
        const regex = new RegExp(pattern);
        filtered = filtered.filter(doc => regex.test(doc.filePath));
      } else if (filters.filePath.endsWith('.ts') || filters.filePath.endsWith('.tsx') ||
                 filters.filePath.endsWith('.js') || filters.filePath.endsWith('.jsx')) {
        filtered = filtered.filter(doc => doc.filePath.endsWith(filters.filePath!));
      } else {
        filtered = filtered.filter(doc => doc.filePath.includes(filters.filePath!));
      }
    }
    if (filters.fileType) {
      filtered = filtered.filter(doc => doc.filePath.endsWith(filters.fileType!));
    }
    if (filters.hasJsDoc !== undefined) {
      filtered = filtered.filter(doc => {
        const hasJsDoc = doc.jsDoc && doc.jsDoc.description && doc.jsDoc.description.length > 0;
        return filters.hasJsDoc ? hasJsDoc : !hasJsDoc;
      });
    }
    if (filters.complexity) {
      filtered = filtered.filter(doc => {
        if (!doc.complexity) return false;
        const min = filters.complexity!.min || 0;
        const max = filters.complexity!.max || Infinity;
        return doc.complexity >= min && doc.complexity <= max;
      });
    }
    if (filters.hasAnyDependency && filters.hasAnyDependency.length > 0) {
      filtered = filtered.filter(doc =>
        filters.hasAnyDependency!.some(dep => doc.dependencies.includes(dep))
      );
    }
    if (filters.metadata) {
      filtered = filtered.filter(doc => matchesMetadataFilter(doc, filters.metadata!));
    }
    return filtered;
  }

  private excludeTermsFromResults(
    results: FunctionDocument[],
    excludedTerms: string[]
  ): FunctionDocument[] {
    return results.filter(doc => {
      const searchText = [
        doc.name, doc.purpose, doc.context,
        doc.jsDoc?.description, doc.returnType,
        ...(doc.parameters || []).map((p: any) => `${p.name} ${p.description || ''}`),
        ...doc.dependencies
      ].filter(Boolean).join(' ').toLowerCase();
      return !excludedTerms.some(term => searchText.includes(term.toLowerCase()));
    });
  }
}

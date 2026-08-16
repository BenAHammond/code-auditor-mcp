/**
 * Drizzle ORM Adapter — Spec 15 R2
 *
 * Extracts table references and schema definitions from Drizzle ORM code:
 *
 *   Schema:  pgTable('users', { ... }), mysqlTable(...), sqliteTable(...)
 *   Queries:  db.select().from(users), db.insert(users).values(...),
 *             db.update(users).set(...), db.delete(users)
 */

import type { OrmAdapter, OrmTableReference, OrmSchemaDefinition } from './types.js';
import type { AST, ASTNode, LanguageAdapter } from '../../languages/types.js';

// ---------------------------------------------------------------------------
// Table-creation call names
// ---------------------------------------------------------------------------

const TABLE_BUILDERS = new Set([
  'pgTable',
  'mysqlTable',
  'sqliteTable',
]);

// ---------------------------------------------------------------------------
// Query operation method names
// ---------------------------------------------------------------------------

const QUERY_METHODS: Record<string, OrmTableReference['type']> = {
  select: 'select',
  insert: 'insert',
  update: 'update',
  delete: 'delete',
};

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Drizzle adapter.
 */
export class DrizzleAdapter implements OrmAdapter {
  readonly name = 'drizzle';
  readonly fileExtensions = ['.ts', '.tsx', '.js', '.jsx'];

  /**
   * Supports file.
   */
  supportsFile(filePath: string): boolean {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    return this.fileExtensions.includes(`.${ext}`);
  }

  // ── Table references from query operations ──────────────────────────────

  /**
   * Extract table references.
   * @param adapter
   * @param ast
   * @param sourceCode
   * @returns
   */
  extractTableReferences(
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string,
  ): OrmTableReference[] {
    // Spec 22 R4.2: File-level gate — only scan files that import drizzle-orm.
    // Prevents false positives from generic .from()/.insert()/.delete() calls
    // in non-Drizzle files (e.g. Array.from(map) → map flagged as a table).
    if (!this.fileImportsDrizzleOrm(ast, adapter, sourceCode)) {
      return [];
    }

    const references: OrmTableReference[] = [];

    // Find all call_expression nodes
    const calls = adapter.findNodes(ast, { type: 'call_expression' });
    for (const call of calls) {
      const ref = this.extractQueryTable(call, adapter, sourceCode);
      if (ref) references.push(ref);
    }

    return references;
  }

  /**
   * Spec 22 R4.2: Check whether the file imports from drizzle-orm.
   *
   * Scans import statement text for "drizzle-orm" — faster and more
   * reliable than AST traversal across language adapters.
   */
  private fileImportsDrizzleOrm(
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string,
  ): boolean {
    const importNodes = adapter.findNodes(ast, { type: 'import_statement' });
    for (const node of importNodes) {
      const text = adapter.getNodeText(node, sourceCode);
      if (text.includes('drizzle-orm')) return true;
    }
    return false;
  }

  /**
   * Try to extract a table reference from a Drizzle query chain.
   *
   * Pattern: db.select().from(users)  or  db.insert(users).values(...)
   * The table identifier is the argument to .from(), or the argument to
   * insert()/update()/delete() when they take a table directly.
   *
   * Spec 22 R4.2: Each pattern requires companion Drizzle methods in the
   * same expression to avoid matching generic .from()/.insert()/.delete()
   * calls (e.g. Array.from(map), .insert(record), .delete(id)).
   * - .from(identifier) requires .select() in the expression
   * - .insert(identifier) requires .values() in the expression
   * - .update(identifier) already requires .set() — no change needed
   * - .delete(identifier) requires .where() in the expression
   */
  private extractQueryTable(
    node: ASTNode,
    adapter: LanguageAdapter,
    sourceCode: string,
  ): OrmTableReference | null {
    const text = adapter.getNodeText(node, sourceCode);
    const location = node.location.start;

    // Spec 22 R4.2: each method requires a companion in the expression to
    // avoid matching generic .from()/.insert()/.delete() calls.
    const from = this.matchTable(text, 'from', 'select');
    if (from) return { ...from, type: 'select', location };

    const insert = this.matchTable(text, 'insert', 'values');
    if (insert) return { ...insert, type: 'insert', location };

    const update = this.matchTable(text, 'update', 'set');
    if (update) return { ...update, type: 'update', location };

    const del = this.matchTable(text, 'delete', 'where');
    if (del) return { ...del, type: 'delete', location };

    return null;
  }

  /** Match `.method(table)` only when the companion method also appears. */
  private matchTable(
    text: string,
    method: string,
    companion: string,
  ): { table: string; context: string } | null {
    const m = text.match(new RegExp(`\\.${method}\\s*\\(\\s*(\\w+)\\s*\\)`));
    if (!m || !new RegExp(`\\.${companion}\\s*\\(`).test(text)) return null;
    return { table: m[1], context: m[0] };
  }

  // ── Schema definitions from table builders ──────────────────────────────

  /**
   * Extract schema definitions.
   * @param ast
   * @param adapter
   * @param sourceCode
   * @returns
   */
  extractSchemaDefinitions(
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string,
  ): OrmSchemaDefinition[] {
    const definitions: OrmSchemaDefinition[] = [];

    // Find all call_expression nodes
    const calls = adapter.findNodes(ast, { type: 'call_expression' });
    for (const call of calls) {
      const def = this.extractTableDefinition(call, adapter, sourceCode);
      if (def) definitions.push(def);
    }

    return definitions;
  }

  /**
   * Extract table name + columns from pgTable/mysqlTable/sqliteTable calls.
   *
   * Pattern: pgTable('tableName', { column: type('name'), ... })
   *   - First arg: string literal → table name
   *   - Second arg: object literal → column definitions
   */
  private extractTableDefinition(
    node: ASTNode,
    adapter: LanguageAdapter,
    sourceCode: string,
  ): OrmSchemaDefinition | null {
    const text = adapter.getNodeText(node, sourceCode);

    // Match table builder call: pgTable('name', { ... })
    const builderMatch = text.match(
      /(pgTable|mysqlTable|sqliteTable)\s*\(\s*['"]([^'"]+)['"]\s*,\s*\{/,
    );
    if (!builderMatch) return null;

    const tableName = builderMatch[2];

    // Extract column definitions from the object literal
    const columns = this.parseColumnDefinitions(text);

    return {
      tableName,
      columns,
      location: node.location.start,
    };
  }

  /**
   * Parse Drizzle column definitions from the table builder's object argument.
   *
   * Pattern: { columnName: type('col_name').notNull(), ... }
   * We extract column name + type name.
   */
  private parseColumnDefinitions(
    text: string,
  ): Array<{ name: string; type: string }> {
    const columns: Array<{ name: string; type: string }> = [];

    // Find the object body: { ... }
    const objMatch = text.match(/\{\s*([\s\S]*)\s*\}\s*\)?/);
    if (!objMatch) return columns;

    const body = objMatch[1];

    // Match each property: columnName: typeCall(...)
    // This is a simplified parser — it handles common Drizzle patterns.
    const propRegex = /(\w+)\s*:\s*(\w+)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = propRegex.exec(body)) !== null) {
      const colName = match[1];
      const colType = match[2];
      // Skip common non-column properties
      if (colName === 'id' || !/^(integer|text|varchar|boolean|real|blob|numeric|timestamp|date|time|json|jsonb|serial|bigint|uuid|pgEnum)$/i.test(colType)) {
        // Still include — strict-enough type names from Drizzle
        columns.push({ name: colName, type: colType });
      } else {
        columns.push({ name: colName, type: colType });
      }
    }

    return columns;
  }
}

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

export class DrizzleAdapter implements OrmAdapter {
  readonly name = 'drizzle';
  readonly fileExtensions = ['.ts', '.tsx', '.js', '.jsx'];

  supportsFile(filePath: string): boolean {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    return this.fileExtensions.includes(`.${ext}`);
  }

  // ── Table references from query operations ──────────────────────────────

  extractTableReferences(
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string,
  ): OrmTableReference[] {
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
   * Try to extract a table reference from a Drizzle query chain.
   *
   * Pattern: db.select().from(users)  or  db.insert(users).values(...)
   * The table identifier is the argument to .from(), or the argument to
   * insert()/update()/delete() when they take a table directly.
   */
  private extractQueryTable(
    node: ASTNode,
    adapter: LanguageAdapter,
    sourceCode: string,
  ): OrmTableReference | null {
    const text = adapter.getNodeText(node, sourceCode);

    // db.select().from(tableName)
    const fromMatch = text.match(/\.from\s*\(\s*(\w+)\s*\)/);
    if (fromMatch) {
      return {
        table: fromMatch[1],
        type: 'select',
        location: node.location.start,
        context: fromMatch[0],
      };
    }

    // db.insert(tableName).values(...)  → insert
    const insertMatch = text.match(/\.insert\s*\(\s*(\w+)\s*\)/);
    if (insertMatch && /\.values\s*\(/.test(text)) {
      return {
        table: insertMatch[1],
        type: 'insert',
        location: node.location.start,
        context: insertMatch[0],
      };
    }

    // db.update(tableName).set(...)  → update
    const updateMatch = text.match(/\.update\s*\(\s*(\w+)\s*\)/);
    if (updateMatch && /\.set\s*\(/.test(text)) {
      return {
        table: updateMatch[1],
        type: 'update',
        location: node.location.start,
        context: updateMatch[0],
      };
    }

    // db.delete(tableName).where(...)  → delete
    const deleteMatch = text.match(/\.delete\s*\(\s*(\w+)\s*\)/);
    if (deleteMatch) {
      return {
        table: deleteMatch[1],
        type: 'delete',
        location: node.location.start,
        context: deleteMatch[0],
      };
    }

    return null;
  }

  // ── Schema definitions from table builders ──────────────────────────────

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

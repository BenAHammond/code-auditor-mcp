/**
 * Prisma ORM Adapter — Spec 15 R2
 *
 * Extracts table references and schema definitions from Prisma ORM code:
 *
 *   Schema:  model User { ... } blocks in schema.prisma files
 *   Queries:  prisma.user.findMany(), prisma.user.create(...),
 *             prisma.user.update(...), prisma.user.delete(...)
 */

import type { OrmAdapter, OrmTableReference, OrmSchemaDefinition } from './types.js';
import type { AST, LanguageAdapter } from '../../languages/types.js';

// ---------------------------------------------------------------------------
// Prisma CRUD operation → usage type mapping
// ---------------------------------------------------------------------------

const PRISMA_OPERATIONS: Record<string, OrmTableReference['type']> = {
  findUnique: 'select',
  findFirst: 'select',
  findMany: 'select',
  findFirstOrThrow: 'select',
  findUniqueOrThrow: 'select',
  count: 'select',
  aggregate: 'select',
  groupBy: 'select',
  create: 'insert',
  createMany: 'insert',
  upsert: 'insert',
  update: 'update',
  updateMany: 'update',
  delete: 'delete',
  deleteMany: 'delete',
};

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class PrismaAdapter implements OrmAdapter {
  readonly name = 'prisma';
  readonly fileExtensions = ['.ts', '.tsx', '.js', '.jsx', '.prisma'];

  supportsFile(filePath: string): boolean {
    const base = filePath.split('/').pop() ?? filePath;
    // Content-based detection for schema files
    if (base === 'schema.prisma' || filePath.endsWith('.prisma')) {
      return true;
    }
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    return this.fileExtensions.includes(`.${ext}`);
  }

  // ── Table references from Prisma client calls ───────────────────────────

  extractTableReferences(
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string,
  ): OrmTableReference[] {
    // Prisma schema files (.prisma) don't contain query calls — skip
    if (ast.filePath.endsWith('.prisma')) return [];

    const references: OrmTableReference[] = [];

    // Find all call_expression nodes
    const calls = adapter.findNodes(ast, { type: 'call_expression' });
    for (const call of calls) {
      const ref = this.extractPrismaCall(call, adapter, sourceCode);
      if (ref) references.push(ref);
    }

    return references;
  }

  /**
   * Extract table + operation from prisma.modelName.operation() calls.
   */
  private extractPrismaCall(
    node: any,
    adapter: LanguageAdapter,
    sourceCode: string,
  ): OrmTableReference | null {
    const text = adapter.getNodeText(node, sourceCode);

    // Match prisma.modelName.operation(...)
    const match = text.match(/prisma\s*\.\s*(\w+)\s*\.\s*(\w+)\s*\(/);
    if (!match) return null;

    const modelName = match[1]; // e.g. "user"
    const operation = match[2]; // e.g. "findMany"

    // Only handle known CRUD operations
    const usageType = PRISMA_OPERATIONS[operation];
    if (!usageType) return null;

    return {
      table: modelName,
      type: usageType,
      location: node.location.start,
      context: match[0],
    };
  }

  // ── Schema definitions from schema.prisma ───────────────────────────────

  extractSchemaDefinitions(
    ast: AST,
    adapter: LanguageAdapter,
    sourceCode: string,
  ): OrmSchemaDefinition[] {
    // Only extract from .prisma schema files
    if (!ast.filePath.endsWith('.prisma') && !ast.filePath.endsWith('schema.prisma')) {
      return [];
    }

    return this.parsePrismaSchema(sourceCode);
  }

  /**
   * Parse model blocks from a Prisma schema file.
   *
   * Prisma schema syntax:
   *   model User {
   *     id        Int      @id @default(autoincrement())
   *     email     String   @unique
   *     name      String?
   *     createdAt DateTime @default(now())
   *   }
   */
  private parsePrismaSchema(sourceCode: string): OrmSchemaDefinition[] {
    const definitions: OrmSchemaDefinition[] = [];

    // Match model blocks: model Name { ... }
    // Uses a simple brace-aware parser for Prisma's declarative syntax.
    const modelRegex = /model\s+(\w+)\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = modelRegex.exec(sourceCode)) !== null) {
      const modelName = match[1];
      const blockStart = match.index + match[0].length;

      // Find closing brace (brace-aware)
      const blockEnd = this.findMatchingBrace(sourceCode, blockStart - 1);
      if (blockEnd === -1) continue;

      const blockBody = sourceCode.slice(blockStart, blockEnd);

      // Count lines before this model to compute its line number
      const lineNumber =
        sourceCode.slice(0, match.index).split('\n').length;

      const columns = this.parseModelFields(blockBody);

      definitions.push({
        tableName: modelName,
        columns,
        location: { line: lineNumber, column: 1 },
      });
    }

    return definitions;
  }

  /**
   * Find the matching closing brace starting from the opening brace position.
   */
  private findMatchingBrace(text: string, openBraceIndex: number): number {
    let depth = 1;
    for (let i = openBraceIndex + 1; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /**
   * Parse individual field definitions from a model body.
   *
   * Each field: fieldName FieldType @attributes...
   */
  private parseModelFields(
    body: string,
  ): Array<{ name: string; type: string }> {
    const fields: Array<{ name: string; type: string }> = [];

    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@')) {
        continue;
      }

      // Match: fieldName FieldType ...
      const fieldMatch = trimmed.match(/^(\w+)\s+(\w+)(\?)?/);
      if (!fieldMatch) continue;

      const fieldName = fieldMatch[1];
      let fieldType = fieldMatch[2];
      const optional = fieldMatch[3]; // "?" suffix

      if (optional) fieldType += '?';

      // Skip relation fields (types that are other model names are still valid)
      fields.push({ name: fieldName, type: fieldType });
    }

    return fields;
  }
}

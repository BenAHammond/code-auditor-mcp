/**
 * Spec-19 R4 — DRY sub-rule retirement
 *
 * Verifies:
 * - Item 21-23: duplicate-import — never emitted (cross-file import sharing
 *   is normal ES module behavior)
 * - Item 24-25: duplicate-string-literal — never emitted (CSS class names
 *   and test fixture identifiers are intentionally reused)
 * - Item 26-27: dry/structural-similarity — default-off (CRUD handlers and
 *   API routers are structurally similar by design; fires when enabled)
 * - Positive control: dry/duplicate still fires for token-identical blocks
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages, LanguageRegistry } from '../../../languages/index.js';
import { parseFile } from '../../../languages/adapterBridge.js';
import type { LanguageAdapter } from '../../../languages/types.js';
import { UniversalDRYAnalyzer, DEFAULT_DRY_CONFIG } from '../../../analyzers/universal/UniversalDRYAnalyzer.js';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const fixtureDir = join(tmpdir(), 'spec19-r4-' + Date.now());

// ── Fixture sources ──────────────────────────────────────────────────

/**
 * File A — imports three modules. With a second file importing the same
 * modules, the retired duplicate-import sub-rule would have flagged this.
 * Should produce zero dry/duplicate-import findings post-R4.
 */
const FILE_A_IMPORTS = `
import { useState, useEffect } from 'react';
import { z } from 'zod';
import { pgTable, text, integer } from 'drizzle-orm/pg-core';

export function useCounter() {
  const [count, setCount] = useState(0);
  useEffect(() => { setCount(c => c + 1); }, []);
  return count;
}
`;

/**
 * File B — imports the same three modules. Combined with File A, the
 * retired duplicate-import rule would have flagged react/zod/drizzle-orm.
 */
const FILE_B_IMPORTS = `
import { useState, useCallback } from 'react';
import { z } from 'zod';
import { pgTable, text, integer } from 'drizzle-orm/pg-core';

export function useToggle() {
  const [on, setOn] = useState(false);
  const toggle = useCallback(() => setOn(o => !o), []);
  return { on, toggle };
}
`;

/**
 * File with repeated string literals — CSS class names reused across
 * components. The retired duplicate-string-literal sub-rule would flag
 * "flex", "items-center", etc. Should produce zero findings post-R4.
 */
const DUPLICATE_STRINGS = `
import React from 'react';

export function Header() {
  return (
    <header className="flex items-center justify-between p-4 bg-white shadow">
      <h1 className="flex items-center text-lg font-bold">Dashboard</h1>
      <nav className="flex items-center gap-4">
        <a className="flex items-center text-blue-600 hover:underline">Home</a>
        <a className="flex items-center text-blue-600 hover:underline">Settings</a>
      </nav>
    </header>
  );
}

export function Sidebar() {
  return (
    <aside className="flex items-center flex-col p-4 bg-gray-50">
      <button className="flex items-center w-full p-2 rounded hover:bg-gray-200" data-testid="sidebar-home">
        Home
      </button>
      <button className="flex items-center w-full p-2 rounded hover:bg-gray-200" data-testid="sidebar-settings">
        Settings
      </button>
    </aside>
  );
}
`;

/**
 * File with structurally similar methods — same node-type sequence,
 * different identifiers/literals. dry/structural-similarity is default-off
 * (Spec-19 R4.2). Should produce zero findings with default config.
 * Fires when checkStructuralSimilarity is enabled.
 */
const STRUCTURAL_SIMILAR = `
export class UserController {
  async getOrdersByCustomer(customerId: string, status: string): Promise<Order[]> {
    if (!customerId || customerId.length === 0) {
      throw new BadRequestError('customerId is required');
    }
    if (!status || status.length === 0) {
      throw new BadRequestError('status is required');
    }
    const query = \`
      SELECT * FROM orders
      WHERE customer_id = \${customerId}
        AND status = \${status}
      ORDER BY created_at DESC
    \`;
    const result = await db.execute(query);
    if (!result || result.rows.length === 0) {
      return [];
    }
    const orders = result.rows.map(r => ({
      id: r.order_id,
      total: r.total_amount,
      date: r.created_at,
    }));
    return orders;
  }

  async getProductsBySupplier(supplierId: string, category: string): Promise<Product[]> {
    if (!supplierId || supplierId.length === 0) {
      throw new BadRequestError('supplierId is required');
    }
    if (!category || category.length === 0) {
      throw new BadRequestError('category is required');
    }
    const query = \`
      SELECT * FROM products
      WHERE supplier_id = \${supplierId}
        AND category = \${category}
      ORDER BY created_at DESC
    \`;
    const result = await db.execute(query);
    if (!result || result.rows.length === 0) {
      return [];
    }
    const items = result.rows.map(r => ({
      id: r.item_id,
      price: r.unit_price,
      date: r.created_at,
    }));
    return items;
  }
}
`;

/**
 * Positive control — two token-identical significant blocks ≥ 15 lines.
 * dry/duplicate MUST still fire because this sub-rule is NOT retired.
 * Uses the same for-loop-block pattern as the spec-17 fixture 13.
 */
const TOKEN_IDENTICAL_DUPLICATE = `
export function processOrders(orders: string[]): string[] {
  const results: string[] = [];

  // Block A: token-identical to Block B (~18 non-blank lines after normalization)
  for (let i = 0; i < orders.length; i++) {
    const item = orders[i];
    if (!item || item.length === 0) {
      continue;
    }
    const trimmed = item.trim().toLowerCase();
    if (trimmed.startsWith("err:")) {
      results.push(\`[ERROR] \${trimmed.slice(4)}\`);
      continue;
    }
    if (trimmed.startsWith("warn:")) {
      results.push(\`[WARN] \${trimmed.slice(5)}\`);
      continue;
    }
    if (trimmed.startsWith("info:")) {
      results.push(\`[INFO] \${trimmed.slice(5)}\`);
      continue;
    }
    if (trimmed.startsWith("debug:")) {
      results.push(\`[DEBUG] \${trimmed.slice(6)}\`);
      continue;
    }
    results.push(trimmed);
  }

  // Block B: token-identical to Block A (~18 non-blank lines after normalization)
  for (let i = 0; i < orders.length; i++) {
    const item = orders[i];
    if (!item || item.length === 0) {
      continue;
    }
    const trimmed = item.trim().toLowerCase();
    if (trimmed.startsWith("err:")) {
      results.push(\`[ERROR] \${trimmed.slice(4)}\`);
      continue;
    }
    if (trimmed.startsWith("warn:")) {
      results.push(\`[WARN] \${trimmed.slice(5)}\`);
      continue;
    }
    if (trimmed.startsWith("info:")) {
      results.push(\`[INFO] \${trimmed.slice(5)}\`);
      continue;
    }
    if (trimmed.startsWith("debug:")) {
      results.push(\`[DEBUG] \${trimmed.slice(6)}\`);
      continue;
    }
    results.push(trimmed);
  }

  return results;
}
`;

type TestCase = {
  name: string;
  files: Record<string, string>;
  /** The file whose violations we assert on */
  subjectFile: string;
  /** Rule IDs that should never appear */
  forbiddenRules: string[];
  /** Rule IDs that must appear (with expected count) */
  requiredRules: Record<string, number>;
  /** Optional config overrides for specific test cases */
  configOverrides?: Partial<typeof DEFAULT_DRY_CONFIG>;
};

const TEST_CASES: TestCase[] = [
  {
    name: 'duplicate-import — never emitted (items 21-23)',
    files: { 'imports-a.ts': FILE_A_IMPORTS, 'imports-b.ts': FILE_B_IMPORTS },
    subjectFile: 'imports-a.ts',
    forbiddenRules: ['duplicate-import'],
    requiredRules: {},
  },
  {
    name: 'duplicate-string-literal — never emitted (items 24-25)',
    files: { 'dup-strings.tsx': DUPLICATE_STRINGS },
    subjectFile: 'dup-strings.tsx',
    forbiddenRules: ['duplicate-string-literal'],
    requiredRules: {},
  },
  {
    name: 'dry/structural-similarity — default-off produces zero (R4.2)',
    files: { 'structural.ts': STRUCTURAL_SIMILAR },
    subjectFile: 'structural.ts',
    forbiddenRules: ['dry/structural-similarity'],
    requiredRules: {},
  },
  {
    name: 'dry/structural-similarity — fires when enabled (R4.2 positive control)',
    files: { 'structural.ts': STRUCTURAL_SIMILAR },
    subjectFile: 'structural.ts',
    forbiddenRules: [],
    requiredRules: { 'dry/structural-similarity': 1 },
    configOverrides: { checkStructuralSimilarity: true, minLineThreshold: 15 },
  },
  {
    name: 'dry/duplicate — still fires (positive control)',
    files: { 'exact-dup.ts': TOKEN_IDENTICAL_DUPLICATE },
    subjectFile: 'exact-dup.ts',
    forbiddenRules: [],
    requiredRules: { 'dry/duplicate': 1 },
    configOverrides: { minLineThreshold: 15 },
  },
];

describe('Spec-19 R4: DRY sub-rule retirement', () => {
  let analyzer: UniversalDRYAnalyzer;
  let tsAdapter: LanguageAdapter;

  beforeAll(async () => {
    initializeLanguages();
    await initParsers();
    await mkdir(fixtureDir, { recursive: true });
    tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
    if (!tsAdapter) throw new Error('TypeScript adapter not found');
    analyzer = new UniversalDRYAnalyzer();
  });

  for (const { name, files, subjectFile, forbiddenRules, requiredRules, configOverrides } of TEST_CASES) {
    it(name, async () => {
      // Write all fixture files
      for (const [fileName, content] of Object.entries(files)) {
        await writeFile(join(fixtureDir, fileName), content, 'utf-8');
      }

      const filePath = join(fixtureDir, subjectFile);
      const sourceCode = await readFile(filePath, 'utf-8');
      const ast = parseFile(filePath, sourceCode)!;
      if (!ast) throw new Error(`Failed to parse ${filePath}`);

      // Pass fullFunctionIndex with the other files to simulate cross-file analysis
      const allFilePaths = Object.keys(files).map(f => join(fixtureDir, f));
      const fullFunctionIndex = [];
      for (const otherPath of allFilePaths) {
        if (otherPath === filePath) continue;
        const otherSource = await readFile(otherPath, 'utf-8');
        const otherAst = parseFile(otherPath, otherSource);
        if (otherAst) {
          const functions = tsAdapter.extractFunctions(otherAst);
          for (const func of functions) {
            fullFunctionIndex.push({
              filePath: otherPath,
              name: func.name,
              startLine: func.location.start.line,
              endLine: func.location.end.line,
              // The analyzer casts to `any` to access body/metadata.body
              body: func.body ?? '',
            } as any);
          }
        }
      }

      const violations = await (analyzer as any).analyzeAST(
        ast,
        tsAdapter,
        { ...DEFAULT_DRY_CONFIG, ...configOverrides, fullFunctionIndex },
        sourceCode
      );

      // Assert forbidden rules produce zero findings
      for (const rule of forbiddenRules) {
        const matches = violations.filter((v: { rule: string }) => v.rule === rule);
        expect(
          matches.length,
          `Found ${matches.length} "${rule}" violations (expected 0 — sub-rule retired): ${JSON.stringify(matches.slice(0, 3))}`
        ).toBe(0);
      }

      // Assert required rules produce expected count
      for (const [rule, expectedCount] of Object.entries(requiredRules)) {
        const matches = violations.filter((v: { rule: string }) => v.rule === rule);
        expect(
          matches.length,
          `Expected ${expectedCount} "${rule}" violations, got ${matches.length}`
        ).toBe(expectedCount);
      }
    });
  }
});

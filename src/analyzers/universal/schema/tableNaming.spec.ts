/**
 * Spec 49 Session 19 — `table-naming-convention` (row 72).
 *
 * The ledger gap: the rule used "contains uppercase" (`/[A-Z]/`, minus a
 * hardcoded `Table`-suffix exemption) as a proxy for "not snake_case". That
 * proxy flagged all-caps names as PascalCase while letting ORM `XxxTable` class
 * names pass — and, more importantly, it MISSED non-snake_case names with no
 * uppercase letter (`order-items`, `123orders`). The bridgeable fix — replace
 * with an explicit `/^[a-z][a-z0-9_]*$/` conformance check — was already applied
 * in spec-44 (commit `13dd2cb`), but that commit shipped no test.
 *
 * These three tests pin the conformance check directly:
 *   - positive: PascalCase fires.
 *   - near-miss: snake_case and the ORM `Table`-suffix policy do NOT fire.
 *   - inverse near-miss: non-snake_case names with no uppercase fire (the
 *     regression guard — the old uppercase proxy would have missed them).
 */

import { describe, it, expect } from 'vitest';
import { checkNamingConventions } from './codeAnalysis.js';
import type { TableReference } from './types.js';

function ref(table: string): TableReference {
  return { table, type: 'select', location: { line: 1, column: 1 }, context: '' };
}

function rules(tables: string[]): string[] {
  return checkNamingConventions(tables.map(ref), 'test.ts').map(v => v.rule);
}

describe('table-naming-convention (snake_case conformance)', () => {
  it('positive — a PascalCase name is not snake_case and fires', () => {
    expect(rules(['OrderItems'])).toContain('table-naming-convention');
  });

  it('near-miss — snake_case and an ORM Table-suffix class do NOT fire', () => {
    expect(rules(['order_items'])).not.toContain('table-naming-convention');
    expect(rules(['OrderItemsTable'])).not.toContain('table-naming-convention');
  });

  it('inverse near-miss — a non-snake_case name with no uppercase fires (uppercase proxy missed it)', () => {
    // Neither `order-items` nor `123orders` contains an uppercase letter, so the
    // old `/[A-Z]/` proxy would have let them pass; the conformance check must flag.
    expect(rules(['order-items'])).toContain('table-naming-convention');
    expect(rules(['123orders'])).toContain('table-naming-convention');
  });
});

/**
 * Spec 29 R3 — schema-prisma @@map resolution fixture tests.
 *
 * The createSchemaPrismaVisitor is a pure function (regex on source code).
 * These tests verify:
 *   - @@map renames the catalog entry
 *   - Model with no @@map uses its own name
 *   - @@map inside enum/type blocks is scoped out
 *   - @map (field-level, single @) is not confused with @@map
 */

import { describe, it, expect } from 'vitest';
import { createSchemaPrismaVisitor } from './pipelineAdapters.js';

// ── Helper ───────────────────────────────────────────────────────────────────

async function extractModels(source: string): Promise<string[]> {
  const visitor = createSchemaPrismaVisitor();
  const context = { projectRoot: '/tmp', filePath: 'test.prisma', config: {} };
  const result = await visitor.visit(null, null, context, source);
  return ((result.facts['test.prisma'] as any)?.prismaModels) ?? [];
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

describe('schema-prisma — @@map resolution', () => {
  it('resolves @@map to the mapped table name', async () => {
    const source = `model Customer {
  id Int @id
  @@map("customers")
}`;
    const models = await extractModels(source);
    expect(models).toEqual(['customers']);
  });

  it('uses model name when no @@map is present', async () => {
    const source = `model User {
  id   Int    @id
  name String
}`;
    const models = await extractModels(source);
    expect(models).toEqual(['User']);
  });

  it('does not pick up @@map from enum blocks', async () => {
    const source = `model Order {
  id Int @id
}

enum Status {
  ACTIVE
  INACTIVE
  @@map("order_status")
}`;
    const models = await extractModels(source);
    expect(models).toEqual(['Order']);
  });

  it('does not confuse @map (field-level) with @@map (table-level)', async () => {
    const source = `model User {
  id    Int    @id
  email String @map("user_email")
}`;
    const models = await extractModels(source);
    expect(models).toEqual(['User']);
  });

  it('mixed: some models with @@map, some without', async () => {
    const source = `model Customer {
  id Int @id
  @@map("customers")
}

model Order {
  id Int @id
}

model Product {
  id Int @id
  @@map("products")
}`;
    const models = await extractModels(source);
    expect(models).toEqual(['customers', 'Order', 'products']);
  });

  it('binds @@map to the correct model — unmapped before mapped', async () => {
    // This ordering fails under file-wide or positional pairing: a naive
    // "first @@map goes to first model" gives Customer→orders, Order→Order.
    // Brace-scoped extraction gives Customer→Customer, Order→orders.
    const source = `model Customer {
  id Int @id
}

model Order {
  id Int @id
  @@map("orders")
}`;
    const models = await extractModels(source);
    expect(models).toEqual(['Customer', 'orders']);
  });

  it('handles @@map with whitespace variations', async () => {
    const source = `model Foo {
  id Int @id
  @@map("foo_table")
}

model Bar {
  id Int @id
  @@map( "bar_table" )
}

model Baz {
  id Int @id
  @@map(\n"baz_table"\n)
}`;
    const models = await extractModels(source);
    expect(models).toEqual(['foo_table', 'bar_table', 'baz_table']);
  });

  it('returns empty array for file with no models', async () => {
    const source = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}`;
    const models = await extractModels(source);
    expect(models).toEqual([]);
  });
});

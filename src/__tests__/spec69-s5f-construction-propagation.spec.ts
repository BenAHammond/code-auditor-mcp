/**
 * Spec 69 §10 S5f — construction propagation (`new X()` and `.getInstance()`).
 *
 * Three construction sites must fire, pinned must-fire by file and line:
 *
 *   1. hhra-org `database/services/org-tracker-db/index.ts:314`
 *      `export const orgTrackerDb = OrgTrackerDatabase.getInstance()` — a static
 *      accessor returning a singleton whose class declares a handle-typed field
 *      (`private pool: Pool | null = null`, `this.pool = new Pool(config)` at
 *      :97). The class is discovered as a wrapper, then the fixed-point re-runs
 *      propagation so the `.getInstance()` declarator resolves.
 *   2. blitz `apps/web/db/index.ts:7` (and the generator template
 *      `packages/generator/templates/app/db/index.ts:7`) `const db = new
 *      EnhancedPrisma()` — a wrapper-constructor built by a higher-order factory
 *      (`const EnhancedPrisma = enhancePrisma(PrismaClient)`), where the factory
 *      is an unprovenanced identifier that forwards a provenanced `PrismaClient`.
 *   3. queue-worker `queue-worker/src/queue-worker.ts` `this.db = new Database()`
 *      — already pinned by S5c / S5b form 4, not repeated here.
 *
 * (1) and (2) are pinned at the cross-file resolution boundary
 * (`resolveReceiverProvenance`), the live-pipeline replacement for the deleted
 * `DB_RECEIVER_NAMES` list.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { resolveReceiverProvenance } from '../analyzers/receiverResolution.js';
import type { SourceFile } from '../analyzers/receiverResolution.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

async function resolveFile(content: string): Promise<Map<string, unknown>> {
  const file: SourceFile = { path: '/fixture/s5f.ts', content };
  const report = await resolveReceiverProvenance([file]);
  return report.fileProvenance.get('/fixture/s5f.ts') ?? new Map();
}

describe('Spec 69 §10 S5f — construction propagation', () => {
  it('a static .getInstance() singleton over a handle-typed field resolves (orgTrackerDb over pg.Pool)', async () => {
    const prov = await resolveFile([
      'import { Pool } from "pg";',
      '',
      'class OrgTrackerDatabase {',
      '  private static instance: OrgTrackerDatabase;',
      '  private pool: Pool | null = null;',
      '',
      '  private constructor() {',
      '    this.pool = new Pool({});',
      '  }',
      '',
      '  static getInstance(): OrgTrackerDatabase {',
      '    if (!OrgTrackerDatabase.instance) {',
      '      OrgTrackerDatabase.instance = new OrgTrackerDatabase();',
      '    }',
      '    return OrgTrackerDatabase.instance;',
      '  }',
      '',
      '  async query(sql: string) {',
      '    return this.pool!.query(sql);',
      '  }',
      '}',
      '',
      'export const orgTrackerDb = OrgTrackerDatabase.getInstance();',
    ].join('\n'));

    expect(prov.has('OrgTrackerDatabase')).toBe(true);
    expect(prov.has('orgTrackerDb')).toBe(true);
  });

  it('a wrapper constructor built by a higher-order factory resolves (new EnhancedPrisma())', async () => {
    const prov = await resolveFile([
      'import { enhancePrisma } from "blitz";',
      'import { PrismaClient } from "@prisma/client";',
      '',
      'const EnhancedPrisma = enhancePrisma(PrismaClient);',
      '',
      'const db = new EnhancedPrisma();',
      'export default db;',
    ].join('\n'));

    expect(prov.has('EnhancedPrisma')).toBe(true);
    expect(prov.has('db')).toBe(true);
  });

  it('a member-expression callee with a provenanced argument does NOT sweep in (JSON.stringify(db))', async () => {
    const prov = await resolveFile([
      'import { PrismaClient } from "@prisma/client";',
      'const db = new PrismaClient();',
      'const s = JSON.stringify(db);',
      'const logged = console.log(db);',
    ].join('\n'));

    expect(prov.has('db')).toBe(true);
    expect(prov.has('s')).toBe(false);
    expect(prov.has('logged')).toBe(false);
  });
});

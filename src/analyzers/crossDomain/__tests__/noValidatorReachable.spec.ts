/**
 * Spec 49 Session 23 — `cross-domain/validation-bypass` → `no-validator-reachable`
 * (row 85).
 *
 * The ledger gap: the rule ID and its emission message claimed "validation
 * bypass" and "Function '…' is not validated", but the code only computes BFS
 * reachability — does a writer reach a validator function within a bounded call
 * depth while a mode-share of its peers do? Reachability is not "the write's
 * input is validated": a function can validate its input inline (no named
 * validator reachable) and still be flagged, and validator identity degrades to
 * a name-GLOB heuristic. The honest claim is "no validator reachable within BFS
 * depth ≤ N", not "not validated" and not "bypass".
 *
 * These tests pin the honest name and message. The detection (BFS reachability
 * + mode-share gate) is unchanged — this is a rename + reword, not a predicate
 * change — so the positive case fails pre-change (it emits the old ID and the
 * overclaiming message) while the near-miss passes pre-change (it already did
 * not fire).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CodeIndexDB } from '../../../codeIndexDB.js';
import { CrossDomainAnalyzer } from '../CrossDomainAnalyzer.js';
import { RULE_REGISTRY } from '../../ruleRegistry.js';

const projectRoot = '/test/project';
const writerDir = `${projectRoot}/src/handlers`;

async function freshDb(): Promise<CodeIndexDB> {
  CodeIndexDB.resetInstance();
  const db = CodeIndexDB.getInstance(':memory:');
  await db.initialize();
  return db;
}

function seedFunctionEx(
  db: CodeIndexDB,
  name: string,
  filePath: string,
  line: number,
  opts: { isExported?: boolean; usedImports?: string[] } = {},
): number {
  const { isExported = false, usedImports } = opts;
  const info = db.run(
    `INSERT INTO functions (name, file_path, line_number, entity_type, language,
       is_exported, used_imports)
     VALUES (?, ?, ?, 'function', 'typescript', ?, ?)`,
    [name, filePath, line, isExported ? 1 : 0, usedImports ? JSON.stringify(usedImports) : null],
  );
  return Number(info.lastInsertRowid);
}

function seedUsage(db: CodeIndexDB, fn: string, file: string, line: number): void {
  db.run(
    `INSERT INTO schema_usage (table_name, file_path, function_name, usage_type, line)
     VALUES ('orders', ?, ?, 'insert', ?)`,
    [file, fn, line],
  );
}

function seedCallEdge(db: CodeIndexDB, caller: number, callee: number): void {
  db.run(
    `INSERT INTO graph_cache (graph_type, node_key, neighbor_key, weight)
     VALUES ('call', ?, ?, 1.0)`,
    [String(caller), String(callee)],
  );
}

describe('cross-domain/no-validator-reachable (reachability, honest name)', () => {
  let db: CodeIndexDB;
  let analyzer: CrossDomainAnalyzer;

  beforeEach(async () => {
    db = await freshDb();
    analyzer = new CrossDomainAnalyzer();
  });

  afterEach(() => {
    CodeIndexDB.resetInstance();
  });

  async function analyze(config: Record<string, any>) {
    return analyzer.analyze([`${writerDir}/create.ts`], {
      indexHandle: db,
      projectRoot,
      schemaLifecycle: {
        enableWrittenNeverRead: false,
        enableReadNeverWritten: false,
        enableTransactionBoundaryRisk: false,
      },
      ...config,
    });
  }

  it('positive — a writer that does not reach a validator fires under the honest rule ID with an honest message', async () => {
    // Uncovered writer: no call edge to any validator.
    seedFunctionEx(db, 'createOrder', `${writerDir}/createOrder.ts`, 42);
    seedUsage(db, 'createOrder', `${writerDir}/createOrder.ts`, 42);

    // Validator: exported, provenanced (imports zod).
    const vId = seedFunctionEx(db, 'validateOrder', `${writerDir}/validateOrder.ts`, 5, {
      isExported: true,
      usedImports: ['zod'],
    });

    // Second writer reaches the validator → establishes mode-share (1/2 = 0.5).
    const w2Id = seedFunctionEx(db, 'saveOrder', `${writerDir}/saveOrder.ts`, 51);
    seedUsage(db, 'saveOrder', `${writerDir}/saveOrder.ts`, 51);
    seedCallEdge(db, w2Id, vId);

    const result = await analyze({
      validatorBypass: { validators: [], modeShare: 0.5, minCorpus: 2, depth: 3 },
    });

    const v = result.violations.filter(x => x.rule === 'cross-domain/no-validator-reachable');
    expect(v).toHaveLength(1);
    expect(v[0].functionName).toBe('createOrder');
    expect(v[0].message).toContain('does not reach a validator');
    expect(v[0].message).not.toContain('is not validated');
    expect(v[0].message).not.toMatch(/bypass/i);
  });

  it('near-miss — a writer that reaches a validator does NOT fire', async () => {
    // Covered writer reaches the validator directly.
    const wId = seedFunctionEx(db, 'createOrder', `${writerDir}/createOrder.ts`, 42);
    seedUsage(db, 'createOrder', `${writerDir}/createOrder.ts`, 42);

    const vId = seedFunctionEx(db, 'validateOrder', `${writerDir}/validateOrder.ts`, 5, {
      isExported: true,
      usedImports: ['zod'],
    });
    seedCallEdge(db, wId, vId);

    // A second writer also reaches it, so a mode-share exists but no one is uncovered.
    const w2Id = seedFunctionEx(db, 'saveOrder', `${writerDir}/saveOrder.ts`, 51);
    seedUsage(db, 'saveOrder', `${writerDir}/saveOrder.ts`, 51);
    seedCallEdge(db, w2Id, vId);

    const result = await analyze({
      validatorBypass: { validators: [], modeShare: 0.5, minCorpus: 2, depth: 3 },
    });

    expect(result.violations.filter(x => x.rule === 'cross-domain/no-validator-reachable')).toHaveLength(0);
  });

  it('inverse near-miss — an inline-validated writer (no reachable named validator) is reported as reachability, not "not validated"', async () => {
    // The analyzer cannot see inline validation; it only computes BFS reachability.
    // A writer that validates its input in-body has no named validator reachable,
    // so it is flagged — but the message must report only the reachability fact,
    // never the false "is not validated" verdict the old message asserted.
    seedFunctionEx(db, 'createOrder', `${writerDir}/createOrder.ts`, 42);
    seedUsage(db, 'createOrder', `${writerDir}/createOrder.ts`, 42);

    const vId = seedFunctionEx(db, 'validateOrder', `${writerDir}/validateOrder.ts`, 5, {
      isExported: true,
      usedImports: ['zod'],
    });
    const w2Id = seedFunctionEx(db, 'saveOrder', `${writerDir}/saveOrder.ts`, 51);
    seedUsage(db, 'saveOrder', `${writerDir}/saveOrder.ts`, 51);
    seedCallEdge(db, w2Id, vId);

    const result = await analyze({
      validatorBypass: { validators: [], modeShare: 0.5, minCorpus: 2, depth: 3 },
    });

    const v = result.violations.filter(x => x.rule === 'cross-domain/no-validator-reachable');
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain('does not reach a validator');
    expect(v[0].message).not.toContain('is not validated');
  });

  it('registry message claims reachability, not a validation verdict', () => {
    const entry = RULE_REGISTRY['cross-domain/no-validator-reachable'];
    expect(entry).toBeDefined();
    expect(entry.message).not.toMatch(/not validated|bypass/i);
    expect(entry.message).toMatch(/validator|reach/i);
  });
});

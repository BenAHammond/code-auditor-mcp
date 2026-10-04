/**
 * Spec 22 R4.4: Array.map/toLowerCase patterns — should produce ZERO SQL findings.
 *
 * Same as data-access fixture: all method names look SQL-adjacent but
 * operate on plain JS objects. No unknown-table, missing-schemas, or
 * sql-injection findings should fire on this file.
 *
 * The near-miss only means anything if the schema file gate actually opens:
 * a file with no DB handle and no SQL tagged template is rejected by
 * `passesFileGate` before any extraction, so "zero findings" would be vacuous.
 * A real `getDB()` handle below opens the gate and forces the extractor to run
 * over these SQL-adjacent method names — which must still yield zero.
 */

import { getDB } from './db';

function arrayMapPatterns(items: string[]): string[] {
  const fromArray = Array.from(items);
  return fromArray.map(x => x.toLowerCase());
}

function stringMethods(text: string): string {
  const lower = text.toLowerCase();
  const upper = text.toUpperCase();
  return lower + upper;
}

function genericMethodCalls(records: any[]): void {
  const list = { insert: (x: any) => {}, delete: (x: any) => {}, update: (x: any) => {} };
  list.insert(records[0]);
  list.delete(records[0]);
  list.update(records[0]);

  const filter = { select: (x: any) => x, from: (x: any) => x, where: (x: any) => x };
  filter.select(filter.from(1));
}

function objectDestructuring(): void {
  const obj = { from: 1, toLowerCase: 'hello' };
  const { from, toLowerCase } = obj;
  console.log(from, toLowerCase);
}

// Real D1 handle (getDB(): D1Database) — resolution proves `db` is a DB handle,
// which opens the schema file gate. The SQL-adjacent method calls above operate
// on plain objects, not `db`, so they must still produce zero findings.
const db = getDB();

export { arrayMapPatterns, stringMethods, genericMethodCalls, objectDestructuring };

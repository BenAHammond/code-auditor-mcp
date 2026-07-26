/**
 * Spec 22 R4.4: Array.map/toLowerCase patterns — should produce ZERO SQL findings.
 *
 * Same as data-access fixture: all method names look SQL-adjacent but
 * operate on plain JS objects. No unknown-table, missing-schemas, or
 * sql-injection findings should fire on this file.
 */

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

export { arrayMapPatterns, stringMethods, genericMethodCalls, objectDestructuring };

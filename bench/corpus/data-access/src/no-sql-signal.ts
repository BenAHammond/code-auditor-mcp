/**
 * Spec 22 R4.4: Array.map/toLowerCase patterns — should produce ZERO SQL findings.
 *
 * All methods here (.from, .toLowerCase, .insert, .delete, .update) look
 * like SQL/ORM operations but operate on plain-JS arrays and strings.
 * No SQL-adjacent rule should fire on this file.
 */

function arrayMapPatterns(items: string[]): string[] {
  // Array.from has "FROM" as a substring but is a static method, not SQL
  const fromArray = Array.from(items);
  // .map() is a method name but the receiver is an array
  return fromArray.map(x => x.toLowerCase());
}

function stringMethods(text: string): string {
  // .toLowerCase() — no SQL signal
  const lower = text.toLowerCase();
  const upper = text.toUpperCase();
  const trimmed = text.trim();
  return lower + upper + trimmed;
}

function genericMethodCalls(records: any[]): void {
  // .insert, .delete, .update on plain objects — not DB receivers
  const list = { insert: (x: any) => {}, delete: (x: any) => {}, update: (x: any) => {} };
  list.insert(records[0]);
  list.delete(records[0]);
  list.update(records[0]);

  // .from() on an array-like
  const items = records.slice(); // no .from()
  // .select / .where on plain objects
  const filter = { select: (x: any) => x, where: (x: any) => x };
  filter.select(filter.where(1));
}

function objectDestructuring(): void {
  // from/toLowerCase in destructuring — no SQL signal
  const obj = { from: 1, toLowerCase: 'hello' };
  const { from, toLowerCase } = obj;
  console.log(from, toLowerCase);
}

export { arrayMapPatterns, stringMethods, genericMethodCalls, objectDestructuring };

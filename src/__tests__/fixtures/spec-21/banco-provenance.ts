/**
 * Spec-21 R6: Portuguese identifier "banco" (bank).
 *
 * Provenance-only detection — "banco" is NOT in dbReceiverNames,
 * so this MUST fire via import provenance from drizzle-orm.
 */

import { drizzle } from 'drizzle-orm';

const db = {
  DB: { exec: (_sql: string) => [] },
};

// drizzle(env.DB) returns a DB-provenanced object because the callee
// 'drizzle' is imported from a DB package — then 'banco' propagates.
const banco = drizzle(db.DB as any);

// These MUST fire: banco is DB-provenanced via import propagation.
banco.prepare('SELECT * FROM users');
banco.all();
banco.first();

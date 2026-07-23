/**
 * Spec-21 R6: Cyrillic identifier "база" (database).
 *
 * "база" matches zero English name lists. All detection MUST come
 * from import provenance propagation. Verifies Unicode correctness
 * of identifier handling throughout the provenance pipeline.
 */

import { drizzle } from 'drizzle-orm';

const env = { DB: { exec: (_sql: string) => [] } };

// Provenanced via drizzle import — Cyrillic identifier tests
// that the provenance chain handles non-ASCII names correctly.
const база = drizzle(env.DB as any);

// MUST fire: база is DB-provenanced, method is in DB_CALL_METHODS
база.all();
база.first();
база.prepare('SELECT * FROM users');
база.execute = база.all;

/**
 * German identifiers — DB access + loop query (N+1 pattern).
 *
 * "datenbank" (database), "abfragen" (to query), "benutzer" (user) —
 * none of these are English or appear in dbReceiverNames.
 *
 * Detection MUST fire via import provenance from drizzle-orm.
 *
 * Spec 21 R6.2 — non-English bench corpus fixture
 */

import { drizzle } from 'drizzle-orm';

const env = { DB: { exec: (_sql: string) => [] } };

// datenbank is DB-provenanced via drizzle import propagation
const datenbank = drizzle(env.DB as any);

// N+1 pattern: query inside a loop
// triggers: loop-query (warning), missing-org-filter (warning, table "orders"),
//          unfiltered-query (suggestion)
async function benutzerBestellungenAbrufen(benutzerIds: number[]): Promise<Record<number, any[]>> {
  const ergebnisse: Record<number, any[]> = {};

  for (const id of benutzerIds) {
    // Query inside loop — N+1 pattern
    // Non-English variable "datenbank" detected via provenance
    // Table "orders" is English → matches org-filter check
    const bestellung = await datenbank.query(
      'SELECT * FROM orders WHERE user_id = $1',
      [id]
    );
    ergebnisse[id] = bestellung;
  }

  return ergebnisse;
}

// Direct query — triggers missing-org-filter (table "users"), unfiltered-query
async function alleBenutzerAbrufen() {
  const benutzer = await datenbank.query(
    'SELECT * FROM users'
  );
  return benutzer;
}

/**
 * German switch-like function — P2 known-miss for CrossLanguageSOLIDAnalyzer.
 *
 * "verarbeiten" (German = process/handle) is semantically a dispatch function
 * but matches none of the hardcoded English switchLikeNames:
 *   ['handle', 'process', 'convert', 'transform', 'dispatch', 'route']
 *
 * Spec 21 R6.2 — non-English bench corpus fixture.
 * Known-miss: cross-language-solid open-closed.
 * Partial fix: switchLikeNames made configurable in CrossLanguageSOLIDConfig
 * (Spec 21 send-back). Full fix: structural tier detecting actual switch/if-else
 * chains, deferred to Spec 15 neighborhood.
 */
import { drizzle } from 'drizzle-orm';

const env = { DB: { exec: (_sql: string) => [] } };
const db = drizzle(env.DB as any);

// Switch-like dispatch — should trigger open-closed principle detection
export async function verarbeiten(typ: string, daten: unknown) {
  if (typ === 'bestellung') {
    // Also triggers data-access violations (missing-org-filter, unfiltered-query)
    return db.query('SELECT * FROM orders WHERE type = $1', [daten]);
  } else if (typ === 'benutzer') {
    return db.query('SELECT * FROM users WHERE role = $1', [daten]);
  } else if (typ === 'produkt') {
    return db.query('SELECT * FROM products WHERE category = $1', [daten]);
  }
  return null;
}

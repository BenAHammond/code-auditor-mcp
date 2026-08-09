/**
 * transferCredits — TRUE POSITIVE for transaction-boundary.
 *
 * Writes to 2 distinct tables (users + audit_log) in one function without
 * transaction wrapping. With txnTableMax: 2, this should trigger:
 *   cross-domain/transaction-boundary
 */

import { db } from './db.js';

export function transferCredits(from: string, to: string, amount: number): void {
  db.exec(
    `UPDATE users SET credits = credits - ${amount} WHERE id = '${from}'`,
  );
  db.exec(
    `INSERT INTO audit_log (action, amount) VALUES ('transfer', ${amount})`,
  );
}

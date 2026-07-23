/**
 * Spec-21 R6: Cross-file provenance — consumer imports DB-provenanced 'db'.
 *
 * Imports from './provider' which exports a DB-provenanced identifier.
 * Detection MUST fire even though 'db' has no direct DB-package import
 * in this file.
 */

import { db } from './provider';

// MUST fire: db is DB-provenanced through cross-file import provenance.
function getUsers() {
  const stmt = db.prepare('SELECT * FROM users');
  return stmt.all();
}

// MUST fire: calls propagate through the provenanced receiver.
function getUserById(id: number) {
  return db.first('SELECT * FROM users WHERE id = ?', id);
}

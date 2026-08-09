/**
 * queryUsers — SELECT from users table.
 *
 * Establishes that users has reads, so UPDATE users in transfer.ts doesn't
 * trigger written-never-read. Without this file, users would be
 * written-never-read.
 */

import { db } from './db.js';

export function getUserById(id: string): Record<string, unknown> | null {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).get() as Record<string, unknown> | null;
}

export function getAllUsers(): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM users').all() as Array<Record<string, unknown>>;
}

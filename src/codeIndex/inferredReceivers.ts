/**
 * Inferred-receiver storage. Extracted from `CodeIndexDB`; persists the
 * inferred receiver set as a single meta record. Builds on `MetaStore`.
 */

import type { SqliteDatabase } from '../sqlite/types.js';
import { MetaStore } from './meta.js';

export interface InferredReceiver {
  identifier: string;
  file: string;
  reason: string;
}

/**
 * Storage for the inferred receiver set, persisted as a single meta record on
 * the shared SQLite handle through a MetaStore.
 */
export class InferredReceiversStore {
  private readonly meta: MetaStore;

  /**
   * Create the store over the shared SQLite handle.
   *
   * @param db The SQLite database handle.
   */
  constructor(db: SqliteDatabase) {
    this.meta = new MetaStore(db);
  }

  /** Store the inferred receiver set as a meta record. */
  storeInferredReceivers(inferred: InferredReceiver[]): void {
    this.meta.setMeta('inferred_receivers', JSON.stringify(inferred));
  }

  /**
   * Retrieve the inferred receiver set, or null if not stored.
   *
   * @returns The parsed receiver set, or null when absent or unparseable.
   */
  getInferredReceivers(): InferredReceiver[] | null {
    const raw = this.meta.getMeta('inferred_receivers');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

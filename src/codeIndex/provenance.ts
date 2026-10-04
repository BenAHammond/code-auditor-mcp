/**
 * Per-file provenance storage (Spec-21 R2 cross-file). Extracted from
 * `CodeIndexDB`; persists db- and validator-provenanced identifiers under a
 * `provenance:<file>` meta key. Builds on `MetaStore` rather than reaching
 * back into the facade.
 */

import type { SqliteDatabase } from '../sqlite/types.js';
import { MetaStore } from './meta.js';

export interface FileProvenanceData {
  dbProvenanced: Array<{ identifier: string; reason: string; source: string; chain?: string[] }>;
  validatorProvenanced: Array<{ identifier: string; reason: string; source: string; chain?: string[] }>;
}

/**
 * Per-file provenance storage for cross-file identifiers. Persists db- and
 * validator-provenanced identifiers under a `provenance:<file>` meta key via
 * `MetaStore`, so provenance queries never reach back into the index facade.
 */
export class ProvenanceStore {
  private readonly meta: MetaStore;

  /**
   * Build the MetaStore-backed provenance store on a database handle.
   * @param db The SQLite database handle the backing MetaStore reads and writes.
   */
  constructor(db: SqliteDatabase) {
    this.meta = new MetaStore(db);
  }

  /**
   * Store per-file provenance context in the meta table.
   * @param filePath The file the provenance data belongs to.
   * @param provenanceData The db- and validator-provenanced identifier lists to persist.
   */
  storeFileProvenance(filePath: string, provenanceData: FileProvenanceData): void {
    const key = `provenance:${filePath}`;
    this.meta.setMeta(key, JSON.stringify(provenanceData));
  }

  /**
   * Retrieve per-file provenance context, or null if not stored.
   * @param filePath The file whose provenance context to load.
   * @returns The parsed provenance data, or null when absent or unparseable.
   */
  getFileProvenance(filePath: string): FileProvenanceData | null {
    const raw = this.meta.getMeta(`provenance:${filePath}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

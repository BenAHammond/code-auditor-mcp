/**
 * Code-map section storage — the `code_maps` table backing `code_map.get`.
 * Extracted from `CodeIndexDB`; holds only the raw SQLite handle.
 */

import type { SqliteDatabase } from '../sqlite/types.js';
import { tryParseJson } from './shared.js';

/**
 * Data access for the `code_maps` table: store and retrieve the sections that
 * back `code_map.get`, keyed by map id and section type.
 */
export class CodeMapIndex {
  /**
   * Wrap the shared SQLite handle for code-map storage.
   * @param db the SQLite database handle.
   */
  constructor(private db: SqliteDatabase) {}

  /**
   * Store one code map section for a map.
   * @param mapId the code map the section belongs to.
   * @param sectionType the section kind (e.g. overview, modules, dependencies).
   * @param content the section's rendered text.
   * @param metadata optional extra JSON attached to the section.
   * @returns a promise that resolves once the section is written
   */
  async storeCodeMapSection(mapId: string, sectionType: string, content: string, metadata?: any): Promise<void> {
    this.db.prepare(
      `INSERT OR REPLACE INTO code_maps (map_id, section_type, content, metadata_json, timestamp, size)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(mapId, sectionType, content, JSON.stringify(metadata ?? {}), new Date().toISOString(), content.length);
  }

  /**
   * Retrieve one code map section.
   * @param mapId the code map to read from.
   * @param sectionType the section kind to fetch.
   * @returns the section's content and metadata, or null when absent.
   */
  async getCodeMapSection(mapId: string, sectionType: string): Promise<{ content: string; metadata: any } | null> {
    const row = this.db.prepare('SELECT content, metadata_json FROM code_maps WHERE map_id = ? AND section_type = ?')
      .get(mapId, sectionType) as any;
    return row ? { content: row.content, metadata: tryParseJson(row.metadata_json) ?? {} } : null;
  }

  /**
   * List the sections of a code map with size and timestamp.
   * @param mapId the code map whose sections to enumerate.
   * @returns one entry per section, with its type, byte size, and last-write time.
   */
  async listCodeMapSections(mapId: string): Promise<Array<{ sectionType: string; size: number; timestamp: Date }>> {
    const rows = this.db.prepare('SELECT section_type, size, timestamp FROM code_maps WHERE map_id = ?')
      .all(mapId) as any[];
    return rows.map((r: any) => ({ sectionType: r.section_type, size: r.size ?? 0, timestamp: new Date(r.timestamp) }));
  }

  /**
   * Delete code map sections older than the given age.
   * @param olderThanHours age threshold in hours; sections written before the cutoff are removed.
   * @returns the number of rows deleted.
   */
  async clearOldCodeMaps(olderThanHours: number = 24): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare('DELETE FROM code_maps WHERE timestamp < ?').run(cutoff);
    return result.changes;
  }

  /**
   * Delete all sections of a code map.
   * @param mapId the code map to remove.
   * @returns the number of sections deleted.
   */
  async deleteCodeMap(mapId: string): Promise<number> {
    const result = this.db.prepare('DELETE FROM code_maps WHERE map_id = ?').run(mapId);
    return result.changes;
  }
}

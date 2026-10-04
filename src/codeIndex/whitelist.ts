/**
 * Whitelist storage — the `whitelist` table (platform-API / node-builtin /
 * framework-class entries) plus the default seeding. Extracted from
 * `CodeIndexDB`; owns its own `SqliteCollectionAdapter` against the shared
 * handle.
 */

import type { SqliteDatabase } from '../sqlite/types.js';
import { SqliteCollectionAdapter } from './sqliteCollection.js';
import { tryParseJson } from './shared.js';
import {
  WhitelistEntry,
  WhitelistType,
  WhitelistStatus,
  WhitelistSuggestion
} from '../types/whitelist.js';

/**
 * Whitelist storage for platform-API, node-builtin, and framework-class
 * entries. Backs the `whitelist` table through a dedicated collection adapter
 * and seeds the default entries on a fresh store.
 */
export class WhitelistIndex {
  private adapter: SqliteCollectionAdapter;

  /**
   * Create the index over the shared SQLite handle.
   *
   * @param db The SQLite database handle.
   */
  constructor(private db: SqliteDatabase) {
    this.adapter = new SqliteCollectionAdapter(db, 'whitelist');
  }

  /**
   * Seed the default whitelist rows on a fresh store.
   *
   * @returns Resolves once the defaults are committed in a single transaction.
   */
  async initializeDefaultWhitelists(): Promise<void> {
    const defaults: WhitelistEntry[] = [
      { name: 'Date', type: WhitelistType.PlatformAPI, status: WhitelistStatus.Active, category: 'javascript', addedBy: 'system', addedAt: new Date() },
      { name: 'Error', type: WhitelistType.PlatformAPI, status: WhitelistStatus.Active, category: 'javascript', addedBy: 'system', addedAt: new Date() },
      { name: 'Array', type: WhitelistType.PlatformAPI, status: WhitelistStatus.Active, category: 'javascript', addedBy: 'system', addedAt: new Date() },
      { name: 'Map', type: WhitelistType.PlatformAPI, status: WhitelistStatus.Active, category: 'javascript', addedBy: 'system', addedAt: new Date() },
      { name: 'Set', type: WhitelistType.PlatformAPI, status: WhitelistStatus.Active, category: 'javascript', addedBy: 'system', addedAt: new Date() },
      { name: 'Promise', type: WhitelistType.PlatformAPI, status: WhitelistStatus.Active, category: 'javascript', addedBy: 'system', addedAt: new Date() },
      { name: 'RegExp', type: WhitelistType.PlatformAPI, status: WhitelistStatus.Active, category: 'javascript', addedBy: 'system', addedAt: new Date() },
      { name: 'URL', type: WhitelistType.PlatformAPI, status: WhitelistStatus.Active, category: 'dom', addedBy: 'system', addedAt: new Date() },
      { name: 'URLSearchParams', type: WhitelistType.PlatformAPI, status: WhitelistStatus.Active, category: 'dom', addedBy: 'system', addedAt: new Date() },
      { name: 'FormData', type: WhitelistType.PlatformAPI, status: WhitelistStatus.Active, category: 'dom', addedBy: 'system', addedAt: new Date() },
      { name: 'Headers', type: WhitelistType.PlatformAPI, status: WhitelistStatus.Active, category: 'dom', addedBy: 'system', addedAt: new Date() },
      { name: 'fs', type: WhitelistType.NodeBuiltin, status: WhitelistStatus.Active, patterns: ['fs', 'node:fs', 'fs/promises'], addedBy: 'system', addedAt: new Date() },
      { name: 'path', type: WhitelistType.NodeBuiltin, status: WhitelistStatus.Active, patterns: ['path', 'node:path'], addedBy: 'system', addedAt: new Date() },
      { name: 'crypto', type: WhitelistType.NodeBuiltin, status: WhitelistStatus.Active, patterns: ['crypto', 'node:crypto'], addedBy: 'system', addedAt: new Date() },
      { name: 'NextResponse', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'nextjs', addedBy: 'system', addedAt: new Date() },
      { name: 'NextRequest', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'nextjs', addedBy: 'system', addedAt: new Date() },
      { name: 'Response', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'web-api', addedBy: 'system', addedAt: new Date() },
      { name: 'Request', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'web-api', addedBy: 'system', addedAt: new Date() },
      { name: 'Component', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'react', addedBy: 'system', addedAt: new Date() },
      { name: 'PureComponent', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'react', addedBy: 'system', addedAt: new Date() },
      { name: 'Fragment', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'react', addedBy: 'system', addedAt: new Date() },
      { name: 'StrictMode', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'react', addedBy: 'system', addedAt: new Date() },
      { name: 'Suspense', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'react', addedBy: 'system', addedAt: new Date() },
      { name: 'Pool', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'database', patterns: ['pg'], addedBy: 'system', addedAt: new Date() },
      { name: 'Client', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'database', patterns: ['pg'], addedBy: 'system', addedAt: new Date() },
      { name: 'MongoClient', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'database', patterns: ['mongodb'], addedBy: 'system', addedAt: new Date() },
      { name: 'PrismaClient', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'database', patterns: ['@prisma/client'], addedBy: 'system', addedAt: new Date() },
      { name: 'StackServerApp', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'auth', patterns: ['@stackframe/stack'], addedBy: 'system', addedAt: new Date() },
      { name: 'StackClient', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'auth', patterns: ['@stackframe/stack'], addedBy: 'system', addedAt: new Date() },
      { name: 'ClerkProvider', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'auth', patterns: ['@clerk/nextjs'], addedBy: 'system', addedAt: new Date() },
      { name: 'Auth0Provider', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'auth', patterns: ['@auth0/nextjs-auth0'], addedBy: 'system', addedAt: new Date() },
      { name: 'Axios', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'http', patterns: ['axios'], addedBy: 'system', addedAt: new Date() },
      { name: 'HttpClient', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'http', addedBy: 'system', addedAt: new Date() },
      { name: 'Router', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'express', patterns: ['express'], addedBy: 'system', addedAt: new Date() },
      { name: 'Application', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'express', patterns: ['express'], addedBy: 'system', addedAt: new Date() },
      { name: 'TestingModule', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'testing', patterns: ['@nestjs/testing'], addedBy: 'system', addedAt: new Date() },
      { name: 'MockedProvider', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'testing', patterns: ['@apollo/client/testing'], addedBy: 'system', addedAt: new Date() },
      { name: 'EventEmitter', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'nodejs', patterns: ['events', 'node:events'], addedBy: 'system', addedAt: new Date() },
      { name: 'Readable', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'nodejs', patterns: ['stream', 'node:stream'], addedBy: 'system', addedAt: new Date() },
      { name: 'Writable', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'nodejs', patterns: ['stream', 'node:stream'], addedBy: 'system', addedAt: new Date() },
      { name: 'Transform', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'nodejs', patterns: ['stream', 'node:stream'], addedBy: 'system', addedAt: new Date() },
      { name: 'Buffer', type: WhitelistType.FrameworkClass, status: WhitelistStatus.Active, category: 'nodejs', addedBy: 'system', addedAt: new Date() },
    ];

    const insert = this.db.prepare(`INSERT INTO whitelist (name, type, status, category, description, patterns, added_by, added_at, metadata_json)
      VALUES (@name, @type, @status, @category, @description, @patterns, @added_by, @added_at, @metadata_json)`);

    // Batch the seed rows in one transaction — a single commit instead of one
    // autocommit INSERT per default entry (loop-query / N+1).
    this.db.transaction(() => {
      for (const entry of defaults) {
        insert.run({
          name: entry.name,
          type: entry.type,
          status: entry.status,
          category: entry.category ?? null,
          description: entry.description ?? null,
          patterns: JSON.stringify(entry.patterns ?? []),
          added_by: entry.addedBy ?? 'system',
          added_at: (entry.addedAt ?? new Date()).toISOString(),
          metadata_json: '{}',
        });
      }
    })();
  }

  /**
   * List whitelist entries, optionally filtered by type and status.
   *
   * @param type When given, only entries of this whitelist type are returned.
   * @param status When given, only entries in this status are returned.
   * @returns The matching entries, mapped from their stored rows.
   */
  async getWhitelist(type?: WhitelistType, status?: WhitelistStatus): Promise<WhitelistEntry[]> {
    const rows = this.adapter.find({
      ...(type ? { type } : {}),
      ...(status ? { status } : {}),
    });
    return rows.map((r: any) => ({
      name: r.name,
      type: r.type,
      status: r.status,
      category: r.category,
      description: r.description,
      patterns: tryParseJson(r.patterns),
      addedBy: r.added_by ?? r.addedBy,
      addedAt: new Date(r.added_at ?? r.addedAt),
      updatedAt: r.updated_at ? new Date(r.updated_at) : undefined,
      metadata: tryParseJson(r.metadata_json),
    }));
  }

  /**
   * Insert a new whitelist entry, defaulting status to active and recording the
   * current timestamp.
   *
   * @param entry The entry fields to persist (id and addedAt are assigned here).
   * @returns The stored entry, including the generated id and timestamp.
   */
  async addWhitelistEntry(entry: Omit<WhitelistEntry, 'id' | 'addedAt'>): Promise<WhitelistEntry> {
    const row = this.adapter.insert({
      name: entry.name,
      type: entry.type,
      status: entry.status ?? WhitelistStatus.Active,
      category: entry.category ?? null,
      description: entry.description ?? null,
      patterns: JSON.stringify(entry.patterns ?? []),
      added_by: entry.addedBy ?? 'user',
      added_at: new Date().toISOString(),
      metadata_json: '{}',
    });
    return {
      name: row.name,
      type: row.type,
      status: row.status,
      category: row.category,
      description: row.description,
      patterns: tryParseJson(row.patterns),
      addedBy: row.added_by,
      addedAt: new Date(row.added_at),
    } as WhitelistEntry;
  }

  /** Update a whitelist entry's status. */
  async updateWhitelistStatus(name: string, status: WhitelistStatus): Promise<void> {
    this.db.prepare('UPDATE whitelist SET status = ?, updated_at = ? WHERE name = ?')
      .run(status, new Date().toISOString(), name);
  }

  /**
   * Check whether a name matches an active whitelist entry, either by literal
   * name or by a glob pattern whose `*` is treated as a wildcard.
   *
   * @param name The identifier to test against the whitelist.
   * @param type The whitelist type to restrict matching to.
   * @returns True when the name is covered by an active entry of that type.
   */
  isWhitelisted(name: string, type: WhitelistType): boolean {
    const rows = this.db.prepare(
      'SELECT name, patterns FROM whitelist WHERE type = ? AND status = ?'
    ).all(type, WhitelistStatus.Active) as any[];

    return rows.some(entry => {
      if (entry.name === name) return true;
      const patterns = tryParseJson(entry.patterns);
      if (patterns && Array.isArray(patterns)) {
        return patterns.some((p: string) => {
          if (p.includes('*')) {
            const regex = new RegExp(p.replace(/\*/g, '.*'));
            return regex.test(name);
          }
          return p === name;
        });
      }
      return false;
    });
  }

  /** Detect whitelist candidate suggestions. Currently returns no candidates. */
  async detectWhitelistCandidates(): Promise<WhitelistSuggestion[]> {
    return [];
  }
}

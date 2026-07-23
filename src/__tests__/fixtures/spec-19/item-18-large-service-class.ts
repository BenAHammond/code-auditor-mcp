/**
 * Spec-19 item 18 — solid/class-size TRUE positive (oracle: MUST fire).
 * Service class with 18 methods, aggregate complexity ~150.
 * Legitimate aggregate complexity warning.
 */

interface Entity {
  id: string;
  type: string;
  version: number;
  data: Record<string, unknown>;
}

export class EntityService {
  private db: { query: (sql: string, ...params: unknown[]) => Promise<unknown[]> };
  private cache: Map<string, unknown>;

  constructor(db: { query: (sql: string, ...params: unknown[]) => Promise<unknown[]> }) {
    this.db = db;
    this.cache = new Map();
  }

  async create(entity: Entity): Promise<Entity> {
    if (!entity.id || !entity.type) {
      throw new Error('Missing required fields');
    }
    if (entity.version < 1) {
      throw new Error('Version must be >= 1');
    }
    await this.db.query('INSERT INTO entities (id, type, version, data) VALUES ($1, $2, $3, $4)',
      entity.id, entity.type, entity.version, JSON.stringify(entity.data));
    return entity;
  }

  async getById(id: string): Promise<Entity | null> {
    const cached = this.cache.get(id);
    if (cached) {
      return cached as Entity;
    }
    const rows = await this.db.query('SELECT * FROM entities WHERE id = $1', id);
    if (rows.length === 0) {
      return null;
    }
    const entity = this.rowToEntity(rows[0] as Record<string, unknown>);
    this.cache.set(id, entity);
    return entity;
  }

  async update(id: string, data: Record<string, unknown>): Promise<Entity> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new Error(`Entity ${id} not found`);
    }
    const merged = { ...existing.data, ...data };
    await this.db.query('UPDATE entities SET data = $1, version = version + 1 WHERE id = $2',
      JSON.stringify(merged), id);
    this.cache.delete(id);
    return { ...existing, data: merged, version: existing.version + 1 };
  }

  async delete(id: string): Promise<void> {
    await this.db.query('DELETE FROM entities WHERE id = $1', id);
    this.cache.delete(id);
  }

  async listByType(type: string, limit: number = 100): Promise<Entity[]> {
    const rows = await this.db.query('SELECT * FROM entities WHERE type = $1 LIMIT $2', type, limit);
    return rows.map(r => this.rowToEntity(r as Record<string, unknown>));
  }

  async search(query: string): Promise<Entity[]> {
    const rows = await this.db.query(
      "SELECT * FROM entities WHERE data::text ILIKE $1 LIMIT 50",
      `%${query}%`
    );
    return rows.map(r => this.rowToEntity(r as Record<string, unknown>));
  }

  async countByType(): Promise<Record<string, number>> {
    const rows = await this.db.query('SELECT type, COUNT(*) as cnt FROM entities GROUP BY type');
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      counts[String(r.type)] = Number(r.cnt);
    }
    return counts;
  }

  async batchCreate(entities: Entity[]): Promise<Entity[]> {
    if (entities.length === 0) {
      return [];
    }
    if (entities.length > 1000) {
      throw new Error('Batch size exceeds 1000');
    }
    const results: Entity[] = [];
    for (const entity of entities) {
      if (!entity.id) {
        throw new Error(`Entity missing id at index ${entities.indexOf(entity)}`);
      }
      results.push(await this.create(entity));
    }
    return results;
  }

  async archive(id: string): Promise<void> {
    const entity = await this.getById(id);
    if (!entity) {
      throw new Error(`Entity ${id} not found`);
    }
    await this.db.query(
      'INSERT INTO entities_archive SELECT * FROM entities WHERE id = $1', id);
    await this.db.query('DELETE FROM entities WHERE id = $1', id);
    this.cache.delete(id);
  }

  async restore(id: string): Promise<Entity> {
    const rows = await this.db.query('SELECT * FROM entities_archive WHERE id = $1', id);
    if (rows.length === 0) {
      throw new Error(`Archived entity ${id} not found`);
    }
    const entity = this.rowToEntity(rows[0] as Record<string, unknown>);
    await this.db.query(
      'INSERT INTO entities (id, type, version, data) VALUES ($1, $2, $3, $4)',
      entity.id, entity.type, entity.version, JSON.stringify(entity.data));
    await this.db.query('DELETE FROM entities_archive WHERE id = $1', id);
    return entity;
  }

  async merge(sourceId: string, targetId: string): Promise<Entity> {
    const source = await this.getById(sourceId);
    const target = await this.getById(targetId);
    if (!source) throw new Error(`Source ${sourceId} not found`);
    if (!target) throw new Error(`Target ${targetId} not found`);
    if (source.type !== target.type) {
      throw new Error('Cannot merge entities of different types');
    }
    const merged = { ...source.data, ...target.data };
    return this.update(targetId, merged);
  }

  async export(type: string, format: 'json' | 'csv' = 'json'): Promise<string> {
    const entities = await this.listByType(type, 10000);
    if (format === 'json') {
      return JSON.stringify(entities, null, 2);
    }
    // CSV export
    if (entities.length === 0) {
      return '';
    }
    const headers = ['id', 'type', 'version'];
    const dataKeys = new Set<string>();
    for (const e of entities) {
      Object.keys(e.data).forEach(k => dataKeys.add(k));
    }
    headers.push(...dataKeys);
    const rows = [headers.join(',')];
    for (const e of entities) {
      const row = [e.id, e.type, String(e.version)];
      for (const key of dataKeys) {
        const val = e.data[key];
        row.push(val == null ? '' : String(val).replace(/"/g, '""'));
      }
      rows.push(row.join(','));
    }
    return rows.join('\n');
  }

  async validate(entity: Entity): Promise<string[]> {
    const errors: string[] = [];
    if (!entity.id) errors.push('id is required');
    if (!entity.type) errors.push('type is required');
    if (entity.version < 1) errors.push('version must be >= 1');
    if (!entity.data || Object.keys(entity.data).length === 0) {
      errors.push('data must not be empty');
    }
    return errors;
  }

  async migrate(fromVersion: number, toVersion: number): Promise<number> {
    if (fromVersion >= toVersion) {
      throw new Error('fromVersion must be less than toVersion');
    }
    const rows = await this.db.query(
      'SELECT * FROM entities WHERE version = $1', fromVersion);
    let count = 0;
    for (const row of rows) {
      const entity = this.rowToEntity(row as Record<string, unknown>);
      // Version transformation pipeline
      let data = entity.data;
      if (fromVersion === 1 && toVersion >= 2) {
        data = this.transformV1toV2(data);
      }
      if (toVersion >= 3) {
        data = { ...data, _migrated: true, _migratedAt: new Date().toISOString() };
      }
      await this.db.query(
        'UPDATE entities SET data = $1, version = $2 WHERE id = $3',
        JSON.stringify(data), toVersion, entity.id);
      count++;
    }
    return count;
  }

  async getStats(): Promise<{ total: number; byType: Record<string, number>; avgVersion: number }> {
    const [totalRow] = await this.db.query('SELECT COUNT(*) as cnt FROM entities');
    const total = Number((totalRow as Record<string, unknown>).cnt);
    const byType = await this.countByType();
    const [avgRow] = await this.db.query('SELECT AVG(version) as avg FROM entities');
    const avgVersion = Number((avgRow as Record<string, unknown>).avg) || 0;
    return { total, byType, avgVersion };
  }

  async purgeType(type: string): Promise<number> {
    const rows = await this.db.query('SELECT COUNT(*) as cnt FROM entities WHERE type = $1', type);
    const count = Number((rows[0] as Record<string, unknown>).cnt);
    await this.db.query('DELETE FROM entities WHERE type = $1', type);
    // Clear cache entries for this type
    for (const [key] of this.cache) {
      if (key.includes(type)) {
        this.cache.delete(key);
      }
    }
    return count;
  }

  async clone(id: string, newId: string): Promise<Entity> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new Error(`Entity ${id} not found`);
    }
    const cloned: Entity = {
      id: newId,
      type: existing.type,
      version: 1,
      data: { ...existing.data, _clonedFrom: id },
    };
    return this.create(cloned);
  }

  /**
   * Dispatches an action by type. Complexity intentionally high (~20)
   * to verify method-complexity fires. Each action branch contains
   * sub-branches — if/else-if chains, nested conditionals, and a || fallback.
   */
  async handleComplexDispatch(action: string, params: Record<string, unknown>): Promise<unknown> {
    if (action === 'create') {
      if (params.type === 'A') {
        return this.create(params as Entity);
      } else if (params.type === 'B') {
        return this.create(params as Entity);
      } else if (params.type === 'C') {
        return this.create(params as Entity);
      } else if (params.type === 'D') {
        return this.create(params as Entity);
      } else if (params.type === 'E') {
        return this.create(params as Entity);
      }
    }
    if (action === 'update') {
      if (params.id) {
        return this.update(params.id as string, params as Record<string, unknown>);
      }
    }
    if (action === 'delete') {
      if (params.id) {
        return this.delete(params.id as string);
      }
    }
    if (action === 'list') {
      if (params.type) {
        return this.listByType(params.type as string);
      }
      return this.search((params.query as string) || '');
    }
    if (action === 'export') {
      return this.export(params.type as string, params.format as 'json' | 'csv');
    }
    if (action === 'archive') {
      return this.archive(params.id as string);
    }
    return undefined;
  }

  private rowToEntity(row: Record<string, unknown>): Entity {
    return {
      id: String(row.id),
      type: String(row.type),
      version: Number(row.version),
      data: typeof row.data === 'string' ? JSON.parse(row.data) : (row.data as Record<string, unknown>),
    };
  }

  private transformV1toV2(data: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (data.name) {
      result.displayName = data.name;
    }
    if (data.email) {
      result.emailAddress = data.email;
    }
    return { ...data, ...result };
  }
}

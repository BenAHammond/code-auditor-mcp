/**
 * Shareable analyzer presets (Spec 38 R4).
 *
 * `eslint:recommended` exists so nobody starts from a blank config. The
 * code-auditor analogue is a set of presets, one per ORM/DB stack, that set
 * exactly the config keys that stack needs and nothing else. A project
 * adopting Drizzle should not have to discover `dbReceiverNames`,
 * `tableSources`, `dbBindingNames`, `dbWrapperNames` and the rest by reading
 * the provenance source — the preset names them.
 *
 * Shape: each preset is a namespace-scoped fragment of `analyzerConfigs`
 * (kebab namespaces: `data-access`, `schema`, …). It composes by deep-merging
 * with project config, and a project may extend more than one (a
 * Drizzle-on-Postgres project extends both `drizzle` and `plain-pg`).
 *
 * Precedence when resolving effective config (highest wins):
 *   path-profile > project-config > preset > runtime default
 */

import type { TableSourceEntry } from '../analyzers/universal/schema/types.js';

export interface Preset {
  /** Stable machine id, used in `--preset <id>` and `preset:<id>` sources. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** One-line description shown in help output. */
  description: string;
  /** Companion stacks this preset composes well with. */
  stacks?: string[];
  /**
   * Namespace-scoped config fragments — the same shape as
   * `analyzerConfigs[name]` in .codeauditor.json. Only stack-relevant keys.
   */
  config: Record<string, Record<string, unknown>>;
}

/** Drizzle's three table builders — shared by the `drizzle` preset. */
const DRIZZLE_TABLE_SOURCES: TableSourceEntry[] = [
  { kind: 'callee', name: 'pgTable', arg: 0, description: 'Drizzle PostgreSQL table' },
  { kind: 'callee', name: 'mysqlTable', arg: 0, description: 'Drizzle MySQL table' },
  { kind: 'callee', name: 'sqliteTable', arg: 0, description: 'Drizzle SQLite table' },
];

/** TypeORM's entity/table decorators — shared by the `typeorm` preset. */
const TYPEORM_TABLE_SOURCES: TableSourceEntry[] = [
  { kind: 'decorator', name: 'Entity', arg: 0, description: 'TypeORM @Entity()' },
  { kind: 'decorator', name: 'Table', arg: 0, description: 'TypeORM @Table()' },
  { kind: 'decorator', name: 'ViewEntity', arg: 0, description: 'TypeORM @ViewEntity()' },
];

export const PRESETS: Record<string, Preset> = {
  d1: {
    id: 'd1',
    name: 'Cloudflare D1',
    description: 'Cloudflare Workers D1 — `env.DB` bindings and d1Query/d1Exec wrappers.',
    stacks: ['cloudflare-workers'],
    config: {
      'data-access': {
        dbBindingNames: ['env.DB'],
        dbWrapperNames: ['d1Query', 'd1Exec'],
        dbReceiverNames: ['db', 'database'],
      },
      schema: {
        dbBindingNames: ['env.DB'],
        dbWrapperNames: ['d1Query', 'd1Exec'],
        dbReceiverNames: ['db', 'database'],
        sqlTagNames: ['sql', 'db'],
        fileGateGlobs: ['**/*.sql', '**/migrations/**'],
      },
    },
  },

  drizzle: {
    id: 'drizzle',
    name: 'Drizzle ORM',
    description: 'Drizzle ORM — pgTable/mysqlTable/sqliteTable builders and the `sql` template tag.',
    stacks: ['postgres', 'mysql', 'sqlite'],
    config: {
      'data-access': {
        dbReceiverNames: ['db', 'database'],
      },
      schema: {
        dbReceiverNames: ['db', 'database'],
        sqlTagNames: ['sql', 'db'],
        tableSources: DRIZZLE_TABLE_SOURCES,
      },
    },
  },

  typeorm: {
    id: 'typeorm',
    name: 'TypeORM',
    description: 'TypeORM — @Entity/@Table/@ViewEntity decorators and DataSource/Repository receivers.',
    stacks: ['postgres', 'mysql', 'sqlite'],
    config: {
      'data-access': {
        dbReceiverNames: ['dataSource', 'manager', 'repository', 'queryRunner', 'connection'],
      },
      schema: {
        dbReceiverNames: ['dataSource', 'manager', 'repository', 'queryRunner', 'connection'],
        tableSources: TYPEORM_TABLE_SOURCES,
      },
    },
  },

  prisma: {
    id: 'prisma',
    name: 'Prisma',
    description: 'Prisma Client — `prisma`/`db` receivers; tables come from schema.prisma models.',
    stacks: ['postgres', 'mysql', 'sqlite'],
    config: {
      'data-access': {
        dbReceiverNames: ['prisma', 'db'],
      },
      schema: {
        dbReceiverNames: ['prisma', 'db'],
      },
    },
  },

  'plain-pg': {
    id: 'plain-pg',
    name: 'node-postgres (plain pg)',
    description: 'node-postgres — `pool`/`client` receivers with `.query()`/`.execute()`.',
    stacks: ['postgres'],
    config: {
      'data-access': {
        dbReceiverNames: ['pool', 'client', 'db', 'database'],
      },
      schema: {
        dbReceiverNames: ['pool', 'client', 'db', 'database'],
        sqlTagNames: ['sql', 'db'],
      },
    },
  },

  knex: {
    id: 'knex',
    name: 'Knex',
    description: 'Knex query builder — knex("table")/db("table") receivers with .raw().',
    stacks: ['postgres', 'mysql', 'sqlite'],
    config: {
      'data-access': {
        dbReceiverNames: ['knex', 'db', 'database'],
      },
      schema: {
        dbReceiverNames: ['knex', 'db', 'database'],
        tableSources: [
          { kind: 'callee', name: 'createTable', arg: 0, description: 'Knex schema.createTable migration' },
          { kind: 'callee', name: 'createTableIfNotExists', arg: 0, description: 'Knex schema.createTableIfNotExists migration' },
        ],
      },
    },
  },
};

export const PRESET_IDS: readonly string[] = Object.keys(PRESETS);

/** Look up a preset by id; `undefined` for unknown ids. */
export function getPreset(id: string): Preset | undefined {
  return PRESETS[id];
}

/**
 * Apply presets to an existing `analyzerConfigs` object. The merged preset
 * layer forms the base; the provided config (project config, path profiles,
 * run options) wins on key collision, and nested namespaces deep-merge so a
 * preset's `tableSources` survives even when the project overrides
 * `dbReceiverNames`.
 *
 * Precedence: project-config > preset (presets merge in order, later wins).
 */
export function applyPresets(
  presetIds: string[],
  analyzerConfigs?: Record<string, unknown>
): Record<string, unknown> {
  const presetLayer = mergePresets(presetIds);
  return deepMerge(presetLayer, analyzerConfigs ?? {});
}

/**
 * Merge several presets (in order) into a single namespace-scoped config
 * fragment. Later presets win on key collision; nested objects are deep-merged
 * so `drizzle` + `plain-pg` compose without one clobbering the other.
 */
export function mergePresets(ids: string[]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const id of ids) {
    const preset = getPreset(id);
    if (!preset) continue;
    for (const [namespace, fragment] of Object.entries(preset.config)) {
      out[namespace] = deepMerge(out[namespace] ?? {}, fragment);
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key] as Record<string, unknown>, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

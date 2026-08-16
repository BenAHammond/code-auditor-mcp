import { describe, it, expect } from 'vitest';
import { PRESETS, PRESET_IDS, getPreset, mergePresets, type Preset } from './presets.js';
import { computeEffectiveConfig } from '../config/effectiveConfig.js';

const ROOT = '/repo';

/** Config keys a preset may set, per namespace — the allowlist a preset must
 *  stay within ("sets the config keys that stack needs and nothing else"). */
const ALLOWED_KEYS: Record<string, Set<string>> = {
  'data-access': new Set([
    'dbReceiverNames',
    'dbCallMethods',
    'dbBindingNames',
    'dbWrapperNames',
    'detection',
    'sanitizerNames',
  ]),
  schema: new Set([
    'dbReceiverNames',
    'dbCallMethods',
    'dbBindingNames',
    'dbWrapperNames',
    'sqlTagNames',
    'tableSources',
    'schemaFiles',
    'fileGateGlobs',
    'detection',
    'schemas',
    'knownTables',
  ]),
};

describe('PRESETS registry (Spec 38 R4)', () => {
  it('exposes six presets with stable ids', () => {
    expect(PRESET_IDS).toEqual(['d1', 'drizzle', 'typeorm', 'prisma', 'plain-pg', 'knex']);
    for (const id of PRESET_IDS) {
      expect(PRESETS[id].id).toBe(id);
      expect(getPreset(id)).toBe(PRESETS[id]);
    }
    expect(getPreset('nope')).toBeUndefined();
  });

  it('each preset stays within stack-relevant namespaces and known keys', () => {
    for (const preset of Object.values(PRESETS)) {
      for (const [namespace, fragment] of Object.entries(preset.config)) {
        expect(namespace, `${preset.id} uses unknown namespace`).toMatch(/^(data-access|schema)$/);
        const allowed = ALLOWED_KEYS[namespace]!;
        for (const key of Object.keys(fragment)) {
          expect(allowed.has(key), `${preset.id}:${namespace}.${key} is not a stack-relevant key`).toBe(true);
        }
      }
    }
  });

  it('populates a table catalog through the mechanism each stack uses', () => {
    // ORM-based presets declare tableSources directly.
    const drizzleSources = PRESETS.drizzle.config.schema.tableSources as Array<Record<string, unknown>>;
    expect(drizzleSources.map((s) => s.name)).toEqual(['pgTable', 'mysqlTable', 'sqliteTable']);
    expect(drizzleSources.every((s) => s.kind === 'callee' && s.arg === 0)).toBe(true);

    const typeormSources = PRESETS.typeorm.config.schema.tableSources as Array<Record<string, unknown>>;
    expect(typeormSources.map((s) => s.name)).toEqual(['Entity', 'Table', 'ViewEntity']);
    expect(typeormSources.every((s) => s.kind === 'decorator' && s.arg === 0)).toBe(true);

    const knexSources = PRESETS.knex.config.schema.tableSources as Array<Record<string, unknown>>;
    expect(knexSources.map((s) => s.name)).toEqual(['createTable', 'createTableIfNotExists']);
    expect(knexSources.every((s) => s.kind === 'callee' && s.arg === 0)).toBe(true);

    // Prisma tables come from schema.prisma models (auto-discovered), not
    // tableSources — the preset only needs to recognise the receiver.
    expect(PRESETS.prisma.config.schema.dbReceiverNames).toContain('prisma');

    // D1 tables come from schema.sql / migration files (fileGateGlobs).
    expect(PRESETS.d1.config.schema.fileGateGlobs).toBeDefined();
  });
});

describe('mergePresets — composition (Spec 38 R4)', () => {
  it('composes a Drizzle-on-Postgres project without clobbering', () => {
    const merged = mergePresets(['drizzle', 'plain-pg']);

    // Both namespaces survive.
    expect(Object.keys(merged).sort()).toEqual(['data-access', 'schema']);

    // Drizzle contributes the ORM table sources; plain-pg contributes the
    // pool/client receivers. They land in the same namespace without one
    // wiping the other.
    expect(merged.schema.tableSources).toEqual(PRESETS.drizzle.config.schema.tableSources);
    expect(merged.schema.dbReceiverNames).toEqual(['pool', 'client', 'db', 'database']);

    // Data-access receivers are a superset covering both stacks.
    const receivers = merged['data-access'].dbReceiverNames as string[];
    expect(receivers).toContain('db');
    expect(receivers).toContain('pool');
  });

  it('later preset wins on key collision, and unknown ids are skipped', () => {
    const merged = mergePresets(['d1', 'prisma', 'does-not-exist']);
    // prisma (later) wins dbReceiverNames over d1.
    expect(merged.schema.dbReceiverNames).toEqual(['prisma', 'db']);
    // d1-only key still present.
    expect(merged.schema.fileGateGlobs).toBeDefined();
  });
});

describe('computeEffectiveConfig — preset layer (Spec 38 R4)', () => {
  it('attributes preset-contributed keys to `preset:<id>`', () => {
    const result = computeEffectiveConfig({
      filePath: `${ROOT}/src/a.ts`,
      projectRoot: ROOT,
      presets: [PRESETS.drizzle],
    });

    const schema = result.analyzers.find((a) => a.namespace === 'schema')!;
    const tableSources = schema.keys.find((k) => k.key === 'schema.tableSources')!;
    expect(tableSources.source).toBe('preset:drizzle');
    expect(tableSources.differsFromDefault).toBe(true);
  });

  it('project config overrides the preset (precedence: project > preset)', () => {
    const result = computeEffectiveConfig({
      filePath: `${ROOT}/src/a.ts`,
      projectRoot: ROOT,
      analyzerConfigs: { schema: { dbReceiverNames: ['custom'] } },
      presets: [PRESETS.drizzle],
    });

    const schema = result.analyzers.find((a) => a.namespace === 'schema')!;
    const receivers = schema.keys.find((k) => k.key === 'schema.dbReceiverNames')!;
    expect(receivers.value).toEqual(['custom']);
    expect(receivers.source).toBe('project-config');
  });

  it('no preset leaves every key attributed to `default`', () => {
    const result = computeEffectiveConfig({
      filePath: `${ROOT}/src/a.ts`,
      projectRoot: ROOT,
    });
    for (const analyzer of result.analyzers) {
      for (const key of analyzer.keys) {
        expect(key.source, `${key.key} should be default`).toBe('default');
      }
    }
  });
});

// Silence the unused-import lint for Preset type in a non-typed file.
void (0 as unknown as Preset);

/**
 * Directive B (item 1) — analyzer config is validated in full, not just by
 * namespace name.
 *
 * The valid shape at every depth comes from the config *types* via their runtime
 * embodiment `RUNTIME_DEFAULT_CONFIGS`; a key that does not exist at a path in
 * the default object throws (through `validateConfig` → `loadConfig`), named by
 * full dotted location and its live equivalent where one exists.
 */

import { describe, it, expect } from 'vitest';
import { validateConfig } from './configLoader.js';

describe('validateConfig — analyzerConfigs shape (full depth)', () => {
  it('rejects an unknown sub-key at any depth, named by full dotted location', () => {
    const errors = validateConfig({
      analyzerConfigs: {
        'data-access': { ormPatterns: ['drizzle-orm'] },
        solid: { ifElseChainThreshold: 4 },
      },
    } as any);

    expect(errors.some((e) => e.includes('analyzerConfigs["data-access"].ormPatterns'))).toBe(true);
    expect(errors.some((e) => e.includes('analyzerConfigs.solid.ifElseChainThreshold'))).toBe(true);
  });

  it('names the live key when an unknown sub-key was renamed, not removed', () => {
    const errors = validateConfig({
      analyzerConfigs: {
        solid: { classMethodThreshold: 10, interfaceMemberThreshold: 15 },
        'data-access': { performanceThresholds: { maxJoins: 5 } },
      },
    } as any);

    expect(
      errors.some((e) =>
        e.includes('analyzerConfigs.solid.classMethodThreshold is not recognised — the live key is "analyzerConfigs.solid.classMethodsThreshold"'),
      ),
    ).toBe(true);
    expect(
      errors.some((e) =>
        e.includes('analyzerConfigs.solid.interfaceMemberThreshold is not recognised — the live key is "analyzerConfigs.solid.maxInterfaceMembers"'),
      ),
    ).toBe(true);
    expect(
      errors.some((e) =>
        e.includes(
          'analyzerConfigs["data-access"].performanceThresholds.maxJoins is not recognised — the live key is "analyzerConfigs["data-access"].performanceThresholds.joinedTableCount"',
        ),
      ),
    ).toBe(true);
  });

  it('accepts a fully live nested config (no errors)', () => {
    const errors = validateConfig({
      analyzerConfigs: {
        solid: { maxMethodsPerClass: 10, classMethodsThreshold: 30, maxInterfaceMembers: 40 },
        'data-access': { performanceThresholds: { joinedTableCount: 6 }, detection: { mode: 'provenance' } },
        'cross-domain': { schemaLifecycle: { txnTableMax: 8 } },
      },
    } as any);

    expect(errors).toEqual([]);
  });

  it('rejects a phantom namespace, naming the live namespace', () => {
    const errors = validateConfig({ analyzerConfigs: { component: { maxComponentComplexity: 5 } } } as any);
    expect(errors.some((e) => e.includes('analyzerConfigs.component is not recognised — the live namespace is "react"'))).toBe(true);
  });
});

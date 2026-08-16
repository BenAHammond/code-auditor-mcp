import { describe, it, expect } from 'vitest';
import {
  flatten,
  computeEffectiveConfig,
  computeTopLevelConfig,
} from './effectiveConfig.js';
import type { PathProfile } from './pathProfiles.js';

const ROOT = '/repo';

function profile(name: string, paths: string[], overrides: Record<string, unknown>): PathProfile {
  return { name, paths, overrides };
}

describe('flatten', () => {
  it('flattens nested objects to dot notation', () => {
    expect(flatten({ a: { b: { c: 1 }, d: 2 }, e: 3 })).toEqual({
      'a.b.c': 1,
      'a.d': 2,
      e: 3,
    });
  });

  it('treats arrays as leaf values', () => {
    expect(flatten({ list: [1, 2, 3] })).toEqual({ list: [1, 2, 3] });
  });

  it('namespaces when given a prefix', () => {
    expect(flatten({ maxMethodsPerClass: 7 }, 'solid')).toEqual({
      'solid.maxMethodsPerClass': 7,
    });
  });
});

describe('computeEffectiveConfig — source attribution (Spec 38 R1)', () => {
  it('attributes every key to `default` and reports no differences when nothing overrides', () => {
    const result = computeEffectiveConfig({
      filePath: `${ROOT}/src/a.ts`,
      projectRoot: ROOT,
    });

    const solid = result.analyzers.find((a) => a.namespace === 'solid')!;
    const key = solid.keys.find((k) => k.key === 'solid.maxMethodsPerClass')!;

    expect(key.value).toBe(15);
    expect(key.source).toBe('default');
    expect(key.differsFromDefault).toBe(false);
    expect(key.defaultValue).toBe(15);

    // No key anywhere may differ when no override exists.
    for (const analyzer of result.analyzers) {
      for (const k of analyzer.keys) {
        expect(k.differsFromDefault, `${k.key} unexpectedly differs`).toBe(false);
      }
    }
  });

  it('attributes a project analyzerConfigs override to `project-config` and marks it differing', () => {
    const result = computeEffectiveConfig({
      filePath: `${ROOT}/src/a.ts`,
      projectRoot: ROOT,
      analyzerConfigs: { solid: { maxMethodsPerClass: 5 } },
    });

    const solid = result.analyzers.find((a) => a.namespace === 'solid')!;
    const key = solid.keys.find((k) => k.key === 'solid.maxMethodsPerClass')!;

    expect(key.value).toBe(5);
    expect(key.source).toBe('project-config');
    expect(key.differsFromDefault).toBe(true);
    expect(key.defaultValue).toBe(15);
  });

  it('attributes a path-profile override to the matching profile and reports the excludeFromGate', () => {
    const profiles: PathProfile[] = [
      profile('scripts', ['scripts/**'], { excludeFromGate: true }),
      profile('strict', ['src/**'], { maxMethodsPerClass: 7 }),
    ];

    const result = computeEffectiveConfig({
      filePath: `${ROOT}/src/a.ts`,
      projectRoot: ROOT,
      pathProfiles: profiles,
    });

    expect(result.matchedProfiles).toEqual(['strict']);
    expect(result.excludeFromGate).toBe(false);

    const solid = result.analyzers.find((a) => a.namespace === 'solid')!;
    const key = solid.keys.find((k) => k.key === 'solid.maxMethodsPerClass')!;
    expect(key.value).toBe(7);
    expect(key.source).toBe('path-profile:strict');
    expect(key.differsFromDefault).toBe(true);
  });

  it('resolves built-in profiles as `builtin:` source', () => {
    const result = computeEffectiveConfig({
      filePath: `${ROOT}/scripts/hook.sh`,
      projectRoot: ROOT,
      pathProfiles: [
        { name: 'scripts-and-tests', paths: ['scripts/**'], overrides: { excludeFromGate: true } },
      ],
    });

    expect(result.matchedProfiles).toEqual(['scripts-and-tests']);
    expect(result.excludeFromGate).toBe(true);
  });

  it('lets path-profile overrides win over project config (highest precedence)', () => {
    const result = computeEffectiveConfig({
      filePath: `${ROOT}/src/a.ts`,
      projectRoot: ROOT,
      analyzerConfigs: { solid: { maxMethodsPerClass: 5 } },
      pathProfiles: [profile('strict', ['src/**'], { maxMethodsPerClass: 9 })],
    });

    const solid = result.analyzers.find((a) => a.namespace === 'solid')!;
    const key = solid.keys.find((k) => k.key === 'solid.maxMethodsPerClass')!;
    expect(key.value).toBe(9);
    expect(key.source).toBe('path-profile:strict');
  });
});

describe('computeTopLevelConfig — source attribution (Spec 38 R1)', () => {
  const base = { includePaths: ['./src'], enabledAnalyzers: ['solid', 'dry'] };

  it('attributes unset keys to `default` even when present in project with equal value', () => {
    const out = computeTopLevelConfig(base, { ...base });
    for (const k of out) {
      expect(k.source).toBe('default');
      expect(k.differsFromDefault).toBe(false);
    }
  });

  it('attributes a differing key to `project-config`', () => {
    const out = computeTopLevelConfig(base, { ...base, enabledAnalyzers: ['solid'] });
    const key = out.find((k) => k.key === 'enabledAnalyzers')!;
    expect(key.source).toBe('project-config');
    expect(key.differsFromDefault).toBe(true);
    expect(key.defaultValue).toEqual(['solid', 'dry']);
  });

  it('surfaces project-only keys (no default) with an undefined defaultValue', () => {
    const out = computeTopLevelConfig(base, { ...base, customThing: 42 });
    const key = out.find((k) => k.key === 'customThing')!;
    expect(key.value).toBe(42);
    expect(key.source).toBe('project-config');
    expect(key.differsFromDefault).toBe(true);
    expect(key.defaultValue).toBeUndefined();
  });
});

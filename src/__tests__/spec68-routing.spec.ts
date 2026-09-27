/**
 * Spec 68 §11.1 — conformance: the both-paths route split.
 *
 * Two properties make the migration safe, and both are pinned here:
 *
 *   1. **Disjoint, exhaustive.** `splitRoutes()` derives `{ migrated, legacy }`
 *      from `MIGRATED_RULES` against `RULE_REGISTRY`. The two sets are disjoint
 *      and their union is the whole registry — a rule can be served by neither
 *      path, or by both, only if the derivation is broken. This is the §0
 *      "dead by selection" defect made impossible: there is no per-rule list to
 *      omit from, because the legacy set is the *complement* of the migrated set.
 *
 *   2. **Per-rule attribution.** Every registry rule maps to exactly one route
 *      (`phase` iff migrated, `legacy` otherwise), and a real audit run records
 *      that attribution in `metadata.routeAttribution` so the split is observable
 *      end-to-end, not just in the derivation function.
 *
 * These are the §11.1 guards: entry points run both paths, and the split that
 * decides which path serves each rule is derived, complete, and audited. The
 * integration case is a real `runAuditDispatch` over a TS-only fixture, which
 * takes the `goFiles.length === 0` branch and returns the runner's result
 * unchanged, so `routeAttribution` is the runner's own record.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { createAuditRunner } from '../auditRunner.js';
import { splitRoutes, attributeRoutes, routeFor } from '../phase/routing.js';
import { MIGRATED_RULES } from '../phase/rules/registry.js';
import { RULE_REGISTRY } from '../analyzers/ruleRegistry.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

const ALL_RULE_IDS = Object.keys(RULE_REGISTRY);

describe('Spec 68 §11.1 — the both-paths route split', () => {
  it('is disjoint and its union is every registry rule', () => {
    const { migrated, legacy } = splitRoutes();

    // Disjoint: no rule on both paths.
    for (const id of migrated) {
      expect(legacy.has(id)).toBe(false);
    }

    // Exhaustive: union covers exactly the registry, nothing more, nothing less.
    const union = new Set([...migrated, ...legacy]);
    expect(union.size).toBe(ALL_RULE_IDS.length);
    for (const id of ALL_RULE_IDS) {
      expect(union.has(id)).toBe(true);
    }

    // The migrated set is exactly MIGRATED_RULES — the derivation is not a
    // hand-written list that could drift from the registry.
    expect([...migrated].sort()).toEqual([...new Set(MIGRATED_RULES.map((r) => r.id))].sort());
  });

  it('attributes every rule to exactly one route, matching the split', () => {
    const { migrated, legacy } = splitRoutes();
    const attribution = attributeRoutes();

    // Total: every registry rule is attributed; no rule is attributed twice.
    expect(attribution.size).toBe(ALL_RULE_IDS.length);
    for (const id of ALL_RULE_IDS) {
      expect(attribution.has(id)).toBe(true);
    }

    // Per-rule: routeFor agrees with the set derivation, and the map matches.
    for (const id of ALL_RULE_IDS) {
      const expected = migrated.has(id) ? 'phase' : 'legacy';
      expect(routeFor(id)).toBe(expected);
      expect(attribution.get(id)).toBe(expected);
    }
    expect([...attribution.entries()].filter(([, r]) => r === 'phase').map(([id]) => id).sort())
      .toEqual([...migrated].sort());
    expect([...attribution.entries()].filter(([, r]) => r === 'legacy').map(([id]) => id).sort())
      .toEqual([...legacy].sort());
  });

  it('a real audit run records the same per-rule attribution in metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ca-spec68-routing-'));
    try {
      await writeFile(join(dir, 'a.ts'), 'export const x = 1;\n');
      const result = await createAuditRunner({ projectRoot: dir, writeToLedger: false } as any).run();

      const attribution = result.metadata?.routeAttribution;
      expect(attribution).toBeDefined();

      const { migrated } = splitRoutes();
      const keys = Object.keys(attribution!);
      expect(keys.sort()).toEqual(ALL_RULE_IDS.slice().sort());

      let phaseCount = 0;
      for (const id of keys) {
        const route = attribution![id];
        expect(route === 'phase' || route === 'legacy').toBe(true);
        expect(route).toBe(migrated.has(id) ? 'phase' : 'legacy');
        if (route === 'phase') phaseCount++;
      }

      // The number of phase-attributed rules is exactly the migrated set — the
      // contract that turns red if a rule is flipped without updating MIGRATED_RULES.
      expect(phaseCount).toBe(MIGRATED_RULES.length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

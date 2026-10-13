/**
 * Pin the restored reachability ranking (item 1 — `reachability` restored in
 * the phase pipeline, `hotspot` removed from the finding shape).
 *
 * `computeReachabilityScores` reduces the corpus `reachability` fact (reverse
 * import adjacency + package entry points) to a per-file score the audit
 * runner stamps on every violation: 1.0 for an entry point (live), 0.5 for a
 * file imported by another (live), 0.0 for a file the graph references by
 * nothing (dead code). The three-value spread is the whole point of the
 * restored field — it lets the runner rank live code above dead code within a
 * severity tier — so this test pins all three values plus the "absent from the
 * corpus ⇒ omitted" contract the caller's `?? 0.5` fallback relies on.
 */

import { describe, it, expect } from 'vitest';
import { computeReachabilityScores } from '../phase/reachability.js';
import type { FileImportsFact, ReachabilityFact } from '../phase/types.js';

describe('computeReachabilityScores', () => {
  it('scores entry point 1.0, imported 0.5, dead 0.0', () => {
    const fileImports: FileImportsFact[] = [
      // `/app/entry.ts` imports `/app/util.ts`; nothing imports `/app/dead.ts`.
      { file: '/app/entry.ts', imports: ['/app/util.ts'], hasExports: true, unresolvedDynamicImports: [] },
      { file: '/app/util.ts', imports: [], hasExports: true, unresolvedDynamicImports: [] },
      { file: '/app/dead.ts', imports: [], hasExports: true, unresolvedDynamicImports: [] },
    ];
    const reachability: ReachabilityFact = {
      importersOf: { '/app/util.ts': ['/app/entry.ts'] },
      packageEntryPoints: ['/app/entry.ts'],
    };

    const scores = computeReachabilityScores(fileImports, reachability);

    expect(scores.get('/app/entry.ts')).toBe(1);
    expect(scores.get('/app/util.ts')).toBe(0.5);
    expect(scores.get('/app/dead.ts')).toBe(0);
  });

  it('treats a framework entry-point filename (e.g. /scripts/) as live 1.0, not dead', () => {
    // A script file nothing imports is a framework entry point under
    // `isEntryPointFile` — the same heuristic `unreferenced-module` uses to
    // withhold a dead-code finding. It must rank live, not dead.
    const fileImports: FileImportsFact[] = [
      { file: '/app/scripts/extract.ts', imports: [], hasExports: true, unresolvedDynamicImports: [] },
    ];
    const reachability: ReachabilityFact = { importersOf: {}, packageEntryPoints: [] };

    const scores = computeReachabilityScores(fileImports, reachability);

    expect(scores.get('/app/scripts/extract.ts')).toBe(1);
  });

  it('omits files absent from the corpus so the caller can fall back to neutral 0.5', () => {
    const fileImports: FileImportsFact[] = [
      { file: '/app/live.ts', imports: [], hasExports: true, unresolvedDynamicImports: [] },
    ];
    const reachability: ReachabilityFact = {
      importersOf: {},
      packageEntryPoints: [],
    };

    const scores = computeReachabilityScores(fileImports, reachability);

    expect(scores.has('/app/live.ts')).toBe(true);
    expect(scores.has('/elsewhere/not-in-corpus.ts')).toBe(false);
  });
});

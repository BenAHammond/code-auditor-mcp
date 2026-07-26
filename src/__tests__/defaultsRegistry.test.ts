/**
 * Guard: the shipped enabledAnalyzers list must agree with the analyzer
 * registry. Ghost names (in defaults but not registered) produce silent
 * no-ops. Absent names (registered but not in defaults) mean users never
 * see that analyzer — the schema bug (3.0.0–3.5.x).
 *
 * invariants is exempt from the default list: it is conditional and only
 * runs when invariant rules are configured (Spec 05 R3.1).
 */
import { describe, it, expect } from 'vitest';
import { getDefaultConfig } from '../config/defaults.js';
import { DEFAULT_ANALYZERS } from '../auditRunner.js';

/** Analyzers that are intentionally excluded from the default list. */
const CONDITIONAL_ANALYZERS = new Set(['invariants']);

const REGISTRY_KEYS = new Set(Object.keys(DEFAULT_ANALYZERS));
const NON_CONDITIONAL_REGISTRY = new Set(
  [...REGISTRY_KEYS].filter((k) => !CONDITIONAL_ANALYZERS.has(k)),
);

describe('defaults ≡ registry guard', () => {
  const defaults = getDefaultConfig().enabledAnalyzers!;
  const defaultsSet = new Set(defaults);

  it('contains no ghost analyzer names (present in defaults, missing from registry)', () => {
    const ghosts = defaults.filter((name) => !REGISTRY_KEYS.has(name));
    expect(ghosts).toEqual([]);
  });

  it('contains no duplicate entries', () => {
    expect(defaults.length).toBe(defaultsSet.size);
  });

  it('includes every non-conditional registry key', () => {
    const absent = [...NON_CONDITIONAL_REGISTRY].filter(
      (key) => !defaultsSet.has(key),
    );
    expect(absent).toEqual([]);
  });

  it('matches the canonical order: solid, dry, react, data-access, documentation, schema, styles, conventions, cross-domain', () => {
    // Order matters — the first enabled analyzer runs first, and the
    // progress display reflects this order.
    expect(defaults).toEqual([
      'solid',
      'dry',
      'react',
      'data-access',
      'documentation',
      'schema',
      'styles',
      'conventions',
      'cross-domain',
    ]);
  });
});

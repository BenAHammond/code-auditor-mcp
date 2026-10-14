/**
 * Single-source the health-score floor (config-sweep follow-up).
 *
 * The `audit.health` / `audit_health` MCP tools carry a 0-100 pass/fail floor
 * as the `threshold` parameter. That floor was the literal `70`, written in
 * four places: the two tool-definition `default` fields and the two handler
 * fallbacks (`|| 70`) across `mcp.ts` and `mcp-tools-shared.ts`. The literal is
 * the tunable; a floor written four times drifts (the removed `minHealthScore`
 * default was `75`, not `70` — the same symptom).
 *
 * This pins three things:
 *   1. `DEFAULT_HEALTH_SCORE_THRESHOLD` is the single source of the `70`.
 *   2. `resolveHealthThreshold` is the single fallback — both handlers read it,
 *      so they move together when the default changes.
 *   3. The `audit_health` tool-definition `default` references the constant
 *      (not a re-declared literal), so the schema and the runtime floor agree.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_HEALTH_SCORE_THRESHOLD,
  resolveHealthThreshold,
} from '../config/defaults.js';
import { tools } from '../mcp-tools-shared.js';

describe('health-score floor single-source', () => {
  it('DEFAULT_HEALTH_SCORE_THRESHOLD is the single default (70)', () => {
    expect(DEFAULT_HEALTH_SCORE_THRESHOLD).toBe(70);
  });

  it('resolveHealthThreshold falls back to the default when no threshold is given', () => {
    expect(resolveHealthThreshold(undefined)).toBe(DEFAULT_HEALTH_SCORE_THRESHOLD);
    expect(resolveHealthThreshold({})).toBe(DEFAULT_HEALTH_SCORE_THRESHOLD);
  });

  it('resolveHealthThreshold honors an explicit per-call threshold', () => {
    expect(resolveHealthThreshold({ threshold: 85 })).toBe(85);
    // `||` (not `??`) is the historical coercion: a 0 threshold ("always pass")
    // is indistinguishable from "unset" and lands on the default.
    expect(resolveHealthThreshold({ threshold: 0 })).toBe(DEFAULT_HEALTH_SCORE_THRESHOLD);
  });

  it('resolveHealthThreshold layers the configured floor between the arg and the default', () => {
    // Precedence: per-call `threshold` arg → configured `minHealthScore` → default.
    expect(resolveHealthThreshold(undefined, 82)).toBe(82);
    expect(resolveHealthThreshold({}, 82)).toBe(82);
    expect(resolveHealthThreshold({ threshold: 85 }, 82)).toBe(85); // arg wins over config
    expect(resolveHealthThreshold(undefined, undefined)).toBe(DEFAULT_HEALTH_SCORE_THRESHOLD);
  });

  it('the audit_health tool schema default references the constant, not a literal', () => {
    const auditHealth = tools.find((t) => t.name === 'audit_health');
    expect(auditHealth).toBeDefined();
    const threshold = auditHealth!.parameters.find((p) => p.name === 'threshold');
    expect(threshold).toBeDefined();
    expect(threshold!.default).toBe(DEFAULT_HEALTH_SCORE_THRESHOLD);
  });
});

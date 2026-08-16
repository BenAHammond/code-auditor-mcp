import { describe, it, expect } from 'vitest';
import { checkThresholdRationales } from './thresholdRationales.js';

describe('checkThresholdRationales (Spec 36 R5)', () => {
  it('reports a changed threshold and errors without a rationale', () => {
    const { errors, changes } = checkThresholdRationales(
      { solid: { maxLinesPerMethod: 100 } },
      undefined,
    );
    expect(changes).toContainEqual({
      key: 'solid.maxLinesPerMethod',
      defaultValue: 50,
      effectiveValue: 100,
      hasRationale: false,
    });
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/solid\.maxLinesPerMethod/);
    expect(errors[0]).toMatch(/rationale/);
  });

  it('reports the change but does not error when a rationale is present', () => {
    const { errors, changes } = checkThresholdRationales(
      { solid: { maxLinesPerMethod: 100 } },
      { 'solid.maxLinesPerMethod': 'Calibrated to clear the schema analyzer on recall.' },
    );
    expect(changes).toContainEqual({
      key: 'solid.maxLinesPerMethod',
      defaultValue: 50,
      effectiveValue: 100,
      hasRationale: true,
    });
    expect(errors).toEqual([]);
  });

  it('ignores unchanged thresholds and non-threshold config keys', () => {
    const { errors, changes } = checkThresholdRationales(
      {
        solid: { maxLinesPerMethod: 50 }, // equals default
        'data-access': { dbWrapperNames: ['db'] }, // not a registry threshold
      },
      undefined,
    );
    expect(errors).toEqual([]);
    expect(changes).toEqual([]);
  });

  it('handles a nested threshold key (performanceThresholds.joinedTableCount)', () => {
    const { errors, changes } = checkThresholdRationales(
      { 'data-access': { performanceThresholds: { joinedTableCount: 7 } } },
      undefined,
    );
    expect(changes).toContainEqual({
      key: 'data-access.performanceThresholds.joinedTableCount',
      defaultValue: 4,
      effectiveValue: 7,
      hasRationale: false,
    });
    expect(errors.length).toBe(1);
  });

  it('rejects an empty-string rationale as missing', () => {
    const { errors } = checkThresholdRationales(
      { documentation: { minDescriptionLength: 2 } },
      { 'documentation.minDescriptionLength': '   ' },
    );
    expect(errors.length).toBe(1);
  });
});

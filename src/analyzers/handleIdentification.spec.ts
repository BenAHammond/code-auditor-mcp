import { describe, it, expect } from 'vitest';
import {
  combineVerdicts,
  identifyHandle,
  EVIDENCE_SOURCES,
  RESOLUTION_IMPLEMENTATIONS,
  externalClassifierVerdict,
  validateExternalClassifierConfig,
  NO_EXTERNAL_CLASSIFIER,
  type HandleVerdict,
  type CallSite,
  type ResolutionFacts,
} from './handleIdentification.js';
import type { Format } from '../phase/types.js';

const handle = (via: 'sql-argument' | 'declaration-resolution'): HandleVerdict => ({ kind: 'handle', via });
const notHandle = (): HandleVerdict => ({ kind: 'not-handle', via: 'declaration-resolution' });
const unproven = (reason: string): HandleVerdict => ({ kind: 'unproven', reason });

const site = (sqlArgument: string | null, format: Format = 'typescript'): CallSite => ({
  format,
  root: 'db',
  receiver: 'db.query',
  method: 'query',
  sqlArgument,
  thisField: false,
});

const emptyFacts = (resolution: ResolutionFacts['resolution']): ResolutionFacts => ({
  imports: new Map<string, string>(),
  typeAnnotations: new Map<string, string>(),
  bindings: new Map<string, string>(),
  withinFileProvenance: new Map<string, string>(),
  resolution,
});

describe('combineVerdicts', () => {
  it('a handle verdict wins and records which source proved it', () => {
    expect(combineVerdicts([handle('sql-argument'), unproven('no declaration')])).toEqual(
      handle('sql-argument'),
    );
    expect(combineVerdicts([unproven('no sql'), handle('declaration-resolution')])).toEqual(
      handle('declaration-resolution'),
    );
  });

  it('a handle wins even over a conflicting not-handle', () => {
    expect(combineVerdicts([handle('sql-argument'), notHandle()])).toEqual(handle('sql-argument'));
  });

  it('not-handle beats unproven — decided by declaration-resolution alone', () => {
    expect(combineVerdicts([notHandle(), unproven('arg is not a literal')])).toEqual(notHandle());
  });

  it('all not-handle gives not-handle', () => {
    expect(combineVerdicts([notHandle(), notHandle()])).toEqual(notHandle());
  });

  it('multiple unproven reasons are deduplicated and joined', () => {
    expect(combineVerdicts([unproven('a'), unproven('a'), unproven('b')])).toEqual(unproven('a; b'));
  });

  it('an empty input is a safe unproven, never a crash', () => {
    expect(combineVerdicts([])).toEqual(unproven('no evidence source produced a verdict'));
  });
});

describe('identifyHandle', () => {
  it('sql-argument proves handle even when declaration resolution is unproven', () => {
    const verdict = identifyHandle(site('SELECT 1'), emptyFacts({ dialect: 'none', env: null }));
    expect(verdict).toEqual(handle('sql-argument'));
  });

  it('declaration resolution proves not-handle for a non-code format', () => {
    const verdict = identifyHandle(site(null, 'json'), emptyFacts({ dialect: 'none', env: null }));
    expect(verdict).toEqual(notHandle());
  });

  it('both sources silent yields the declaration cause, not the sql-argument silence', () => {
    const verdict = identifyHandle(site(null), emptyFacts({ dialect: 'none', env: null }));
    expect(verdict.kind).toBe('unproven');
    expect(verdict.reason).toContain('missing TypeScript resolution environment');
  });
});

describe('sql-argument source', () => {
  const facts = emptyFacts({ dialect: 'none', env: null });

  it('proves handle for a literal SQL argument', () => {
    expect(EVIDENCE_SOURCES['sql-argument'].evaluate(site('SELECT 1'), facts)).toEqual(handle('sql-argument'));
  });

  it('stays silent (empty reason) without a SQL argument', () => {
    expect(EVIDENCE_SOURCES['sql-argument'].evaluate(site(null), facts)).toEqual(unproven(''));
  });
});

describe('resolution implementations', () => {
  it('is total over every Format', () => {
    const formats: readonly Format[] = ['typescript', 'tsx', 'javascript', 'go', 'css', 'scss', 'json', 'sql', 'markup'];
    for (const f of formats) {
      expect(RESOLUTION_IMPLEMENTATIONS[f]).toBeDefined();
    }
  });
});

describe('external-classifier source (post-audit)', () => {
  it('no classifier configured yields unproven with that exact reason', () => {
    expect(NO_EXTERNAL_CLASSIFIER).toEqual({ kind: 'unproven', reason: 'no external classifier configured' });
  });

  it('an out-of-range confidence yields unproven, never a handle', () => {
    expect(externalClassifierVerdict({ confidence: 1.5, provenance: {} }, 0.9)).toEqual({
      kind: 'unproven',
      reason: 'external classifier confidence 1.5 is out of range [0, 1]',
    });
    expect(externalClassifierVerdict({ confidence: Number.NaN, provenance: {} }, 0.9).kind).toBe('unproven');
    expect(externalClassifierVerdict({ confidence: -0.1, provenance: {} }, 0.9).kind).toBe('unproven');
  });

  it('a confidence below the threshold abstains with the confidence in the reason', () => {
    expect(externalClassifierVerdict({ confidence: 0.6, provenance: 'blob' }, 0.9)).toEqual({
      kind: 'unproven',
      reason: 'external classifier confidence 0.6 is below the handle threshold 0.9',
    });
  });

  it('a confidence at or above the threshold is a handle carrying confidence + provenance', () => {
    const provenance = { model: 'x', trace: 'y' };
    expect(externalClassifierVerdict({ confidence: 0.9, provenance }, 0.9)).toEqual({
      kind: 'handle',
      via: 'external-classifier',
      confidence: 0.9,
      provenance,
    });
  });

  it('folds through combineVerdicts, overriding a walk-time unproven', () => {
    const classifier = externalClassifierVerdict({ confidence: 0.95, provenance: 'p' }, 0.9);
    expect(combineVerdicts([unproven('no declaration'), classifier])).toEqual(classifier);
  });

  it('never returns not-handle — inference proves or abstains', () => {
    expect(externalClassifierVerdict({ confidence: 0.5, provenance: 'p' }, 0.9).kind).not.toBe('not-handle');
  });
});

describe('validateExternalClassifierConfig', () => {
  it('accepts a finite threshold in [0, 1]', () => {
    expect(validateExternalClassifierConfig({ threshold: 0.9 })).toEqual({ threshold: 0.9 });
    expect(validateExternalClassifierConfig({ threshold: 0 })).toEqual({ threshold: 0 });
    expect(validateExternalClassifierConfig({ threshold: 1 })).toEqual({ threshold: 1 });
  });

  it('refuses loudly when the threshold is missing or invalid', () => {
    expect(() => validateExternalClassifierConfig(null)).toThrow();
    expect(() => validateExternalClassifierConfig({})).toThrow();
    expect(() => validateExternalClassifierConfig({ threshold: '0.9' })).toThrow();
    expect(() => validateExternalClassifierConfig({ threshold: Number.NaN })).toThrow();
    expect(() => validateExternalClassifierConfig({ threshold: 1.2 })).toThrow();
  });
});

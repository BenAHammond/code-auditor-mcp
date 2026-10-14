/**
 * `validatorPackageList` override (Spec 21 provenance) — the validator-package
 * vocabulary that feeds validator-provenance matching is a named knob, not a
 * hardcoded constant the caller cannot reach.
 *
 * This pins the orphan the config-sweep accidentally deleted: the
 * `BuildProvenanceContextOptions.validatorPackageList` field was declared but
 * `buildProvenanceContext` never read it, so a corpus whose validation lives
 * behind a package outside the built-in list could not feed the cross-domain
 * validator rules. The override must actually change what counts as
 * validator-provenanced, and the built-in default must resolve to the single
 * `DEFAULT_VALIDATOR_PACKAGES` source in `config/defaults.ts`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { buildProvenanceContext } from './provenance.js';
import { DEFAULT_VALIDATOR_PACKAGES } from '../config/defaults.js';

let tsAdapter: LanguageAdapter;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not registered');
}, 30_000);

function validatorProvenancedIds(code: string, validatorPackageList?: string[]): string[] {
  const ast = parseFile('test.ts', code);
  if (!ast) throw new Error('Failed to parse test.ts');
  const ctx = buildProvenanceContext(ast, tsAdapter, code, {
    mode: 'hybrid',
    validatorPackageList,
  });
  return [...ctx.validatorProvenanced.keys()];
}

describe('validatorPackageList override', () => {
  it('defaults to the single DEFAULT_VALIDATOR_PACKAGES vocabulary', () => {
    const ids = validatorProvenancedIds(`
      import { z } from 'zod';
      import Joi from 'joi';
    `);
    expect(ids).toContain('z');
    expect(ids).toContain('Joi');
  });

  it('defaults to exactly DEFAULT_VALIDATOR_PACKAGES (no hidden hardcoded list)', () => {
    // A package absent from DEFAULT_VALIDATOR_PACKAGES must not be treated as a
    // validator by the default vocabulary — proving the default is the single
    // config-defaults source, not a divergent copy inside the analyzer.
    expect(DEFAULT_VALIDATOR_PACKAGES).toContain('zod');
    expect(DEFAULT_VALIDATOR_PACKAGES).not.toContain('@acme/private-validators');
    const ids = validatorProvenancedIds(`import { v } from '@acme/private-validators';`);
    expect(ids).toEqual([]);
  });

  it('narrows to exactly the packages named when overridden', () => {
    const ids = validatorProvenancedIds(
      `
        import { z } from 'zod';
        import Joi from 'joi';
      `,
      ['zod'],
    );
    expect(ids).toContain('z');
    expect(ids).not.toContain('Joi');
  });

  it('admits a private validator package outside the built-in list', () => {
    const ids = validatorProvenancedIds(
      `import { v } from '@acme/validators';`,
      ['@acme/validators'],
    );
    expect(ids).toContain('v');
  });
});

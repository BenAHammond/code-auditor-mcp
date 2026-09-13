/**
 * Spec 57 — telemetry fix contract.
 *
 *   - **positive** — a payload carries exactly the safe fields (schema, install
 *     ID, version, rule, level, reason, signature, language) and nothing else.
 *   - **guard** (acceptance 4 — the one that decides whether this ships) — a
 *     finding on code containing a secret, a table name, and a distinctive
 *     identifier produces a payload containing NONE of the three.
 *   - **guard** (offline) — sending to a dead endpoint resolves `{sent:false}`
 *     and never throws; a missing endpoint is an immediate no-op.
 *   - **near-miss** — the language hint is coarse (extension class), never a path.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from './languages/index.js';
import { parseFile } from './languages/adapterBridge.js';
import { signatureForLocation } from './structuralSignature.js';
import {
  TELEMETRY_SCHEMA_VERSION,
  buildTelemetryPayload,
  formatTelemetryPreview,
  languageHint,
  resolveTelemetryConfig,
  sendTelemetry,
  signatureForFinding,
} from './telemetry.js';
import { setTelemetryOptIn } from './installConfig.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const INSTALL_ID = '11111111-2222-4333-8444-555555555555';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

describe('languageHint', () => {
  it('near-miss — maps extension to a coarse class, never a path', () => {
    expect(languageHint('/some/project/src/Widget.tsx')).toBe('typescript-react');
    expect(languageHint('src/foo.ts')).toBe('typescript');
    expect(languageHint('server.go')).toBe('go');
    expect(languageHint('styles.css')).toBe('other');
  });
});

describe('buildTelemetryPayload', () => {
  it('positive — carries exactly the safe fields', () => {
    const payload = buildTelemetryPayload({
      install_id: INSTALL_ID,
      toolVersion: '1.2.3',
      rule: 'loop-query',
      level: 'critical',
      reason: 'generated code',
      signature: 'for_in_statement ( call_expression )',
      lang: 'typescript',
    });
    expect(payload.install_id).toBe(INSTALL_ID);
    expect(payload.v).toBe('1.2.3');
    expect(payload.rule).toBe('loop-query');
    expect(payload.level).toBe('critical');
    expect(payload.reason).toBe('generated code');
    expect(payload.signature).toBe('for_in_statement ( call_expression )');
    expect(payload.lang).toBe('typescript');
    // The payload structurally has no path/identifier/literal/source fields.
    expect(Object.keys(payload).sort()).toEqual([
      'install_id', 'lang', 'level', 'reason', 'rule', 'schema', 'signature', 'ts', 'v',
    ]);
  });

  it('guard — the schema version is pinned (a shape change is a cross-repo contract break)', () => {
    expect(TELEMETRY_SCHEMA_VERSION).toBe(2);
    const payload = buildTelemetryPayload({
      install_id: INSTALL_ID, toolVersion: '1.2.3', rule: 'r', level: 'high', reason: 'x', signature: 's', lang: 'go',
    });
    expect(payload.schema).toBe(TELEMETRY_SCHEMA_VERSION);
    expect(payload.schema).toBe(2);
  });

  it('guard — a finding on secret-laden code leaks none of it into the payload (acceptance 4)', () => {
    const code = [
      `export function charge(users_table_name: string) {`,
      `  const apiKey = "secret_api_key_4eC39HqLyjWDarjtT1zdp7dc";`,
      `  const distinctiveMarkerZxKq9 = "unlikely_identifier_9f2a";`,
      `  for (const row of users_table_name) { row.save(); }`,
      `  return apiKey;`,
      `}`,
    ].join('\n');
    const ast = parseFile('test.ts', code)!;
    const signature = signatureForLocation(ast, { line: 2, column: 3 })!;
    expect(signature).not.toBeNull();

    const payload = buildTelemetryPayload({
      install_id: INSTALL_ID,
      toolVersion: '1.2.3',
      rule: 'loop-query',
      level: 'critical',
      reason: 'generated code', // benign human reason, not the code
      signature,
      lang: 'typescript',
    });
    const json = JSON.stringify(payload);

    expect(json).not.toContain('secret_api_key_4eC39HqLyjWDarjtT1zdp7dc'); // secret
    expect(json).not.toContain('users_table_name'); // table name
    expect(json).not.toContain('distinctiveMarkerZxKq9'); // distinctive identifier
    expect(json).not.toContain('unlikely_identifier_9f2a'); // literal value
  });
});

describe('formatTelemetryPreview', () => {
  it('positive — previews the payload before sending', () => {
    const payload = buildTelemetryPayload({
      install_id: INSTALL_ID, toolVersion: '1.2.3', rule: 'loop-query', level: 'high', reason: 'generated', signature: 'for_statement', lang: 'go',
    });
    const preview = formatTelemetryPreview(payload);
    expect(preview).toContain('Telemetry payload');
    expect(preview).toContain('loop-query');
    expect(preview).toContain('generated');
    expect(preview).toContain('no file paths');
    expect(preview).toContain(INSTALL_ID);
  });
});

describe('resolveTelemetryConfig', () => {
  it('absence — disabled by default (no user config)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ca-tele-'));
    const config = resolveTelemetryConfig({ dir });
    expect(config.enabled).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the opt-in from the user-level config when enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ca-tele-'));
    setTelemetryOptIn({ enabled: true, endpoint: 'http://x/ingest' }, dir);
    const config = resolveTelemetryConfig({ dir });
    expect(config.enabled).toBe(true);
    expect(config.endpoint).toBe('http://x/ingest');
    rmSync(dir, { recursive: true, force: true });
  });

  it('a caller endpoint override wins over the persisted endpoint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ca-tele-'));
    setTelemetryOptIn({ enabled: true, endpoint: 'http://x/ingest' }, dir);
    const config = resolveTelemetryConfig({ dir, endpoint: 'http://override/ingest' });
    expect(config.endpoint).toBe('http://override/ingest');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('sendTelemetry', () => {
  it('guard — a missing endpoint is an immediate no-op, never an error', async () => {
    const payload = buildTelemetryPayload({
      install_id: INSTALL_ID, toolVersion: '1.2.3', rule: 'r', level: 'high', reason: 'x', signature: 's', lang: 'go',
    });
    const result = await sendTelemetry(payload, '');
    expect(result.sent).toBe(false);
  });

  it('guard — an unreachable endpoint resolves sent:false and never throws', async () => {
    const payload = buildTelemetryPayload({
      install_id: INSTALL_ID, toolVersion: '1.2.3', rule: 'r', level: 'high', reason: 'x', signature: 's', lang: 'go',
    });
    const result = await sendTelemetry(payload, 'http://127.0.0.1:1/', { timeoutMs: 500 });
    expect(result.sent).toBe(false);
  });
});

describe('signatureForFinding', () => {
  it('positive — signs a real file at a location', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ca-sig-'));
    const file = join(dir, 'f.ts');
    writeFileSync(file, `function handler() {\n  for (const x of items) { x.save(); }\n}\n`, 'utf-8');
    const signature = signatureForFinding(file, 2, 3);
    expect(signature).not.toBeNull();
    expect(signature!).toContain('for_in_statement');
    rmSync(dir, { recursive: true, force: true });
  });

  it('absence — a missing file yields null', () => {
    expect(signatureForFinding('/does/not/exist.ts', 1, 1)).toBeNull();
  });
});

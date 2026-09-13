/**
 * Spec 57 — install ID + telemetry opt-in fix contract.
 *
 *   - **positive**  — the install ID is generated once and stable across calls;
 *     the opt-in round-trips enable/disable + endpoint.
 *   - **guard**     — the ID is a random UUID (carrying nothing), the opt-in is
 *     OFF by default, and a malformed opt-in file is fail-closed (off).
 *   - **absence**   — no files → off, and a fresh random ID.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PRIVACY_MESSAGE,
  getInstallId,
  getTelemetryOptIn,
  setTelemetryOptIn,
} from './installConfig.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ca-install-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('getInstallId', () => {
  it('positive — generates a UUID and is stable across calls', () => {
    const dir = scratch();
    const first = getInstallId(dir);
    expect(first).toMatch(UUID_RE);
    expect(getInstallId(dir)).toBe(first);
  });

  it('guard — is random and carries nothing (not derived from machine/user/project)', () => {
    const a = getInstallId(scratch());
    const b = getInstallId(scratch());
    expect(a).not.toBe(b);
    expect(a).toMatch(UUID_RE);
  });
});

describe('telemetry opt-in', () => {
  it('absence — defaults to off with no endpoint', () => {
    expect(getTelemetryOptIn(scratch())).toEqual({ enabled: false, endpoint: '' });
  });

  it('positive — enable round-trips through the file', () => {
    const dir = scratch();
    setTelemetryOptIn({ enabled: true, endpoint: 'https://x/ingest' }, dir);
    expect(getTelemetryOptIn(dir)).toEqual({ enabled: true, endpoint: 'https://x/ingest' });
  });

  it('positive — disable persists off', () => {
    const dir = scratch();
    setTelemetryOptIn({ enabled: true, endpoint: 'https://x/ingest' }, dir);
    setTelemetryOptIn({ enabled: false, endpoint: '' }, dir);
    expect(getTelemetryOptIn(dir)).toEqual({ enabled: false, endpoint: '' });
  });

  it('guard — a malformed opt-in file is fail-closed (off)', () => {
    const dir = scratch();
    setTelemetryOptIn({ enabled: true, endpoint: 'https://x/ingest' }, dir);
    // Corrupt the file.
    writeFileSync(join(dir, 'telemetry.json'), '{ not json', 'utf-8');
    expect(getTelemetryOptIn(dir)).toEqual({ enabled: false, endpoint: '' });
  });
});

describe('PRIVACY_MESSAGE', () => {
  it('states the data is anonymous and the ID is generated locally', () => {
    expect(PRIVACY_MESSAGE).toContain('anonymous');
    expect(PRIVACY_MESSAGE).toContain('generated locally');
  });
});

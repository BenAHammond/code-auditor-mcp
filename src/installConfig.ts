/**
 * Spec 57 — anonymous install ID + telemetry opt-in, persisted at the user level.
 *
 * The install ID is a random value generated locally (never derived from the
 * machine, the user, the project, or anything else) and sent with each telemetry
 * submission so submissions can be grouped by source. It lives in the OS config
 * dir (see `getUserConfigRoot`), NOT the cache dir — a cache wipe must not
 * regenerate it, or source grouping breaks.
 *
 * The opt-in is a one-time decision recorded here (default OFF), toggled by the
 * `telemetry` MCP tool. It is *not* a default and *not* a per-invocation flag.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getUserConfigRoot } from './dataPaths.js';

/** Privacy statement shared by the tool, SKILL, and docs. */
export const PRIVACY_MESSAGE =
  'Data is anonymous, and the ID is generated locally to avoid tracking anything personal.';

/**
 * The default ingest endpoint (the operator's service). Shipped so opt-in is a
 * one-step toggle with a known destination; overridable at enable time and via
 * the CLI `--telemetry-endpoint` flag. It is a default, not a contract — a
 * domain can be pointed at the service later by changing this one value.
 */
export const DEFAULT_TELEMETRY_ENDPOINT =
  'https://code-auditor-dismissals.ben-a-hammond.workers.dev/ingest';

/** Resolve the effective endpoint: an explicit non-blank value wins, else the shipped
 *  default. The endpoint must be an https URL — telemetry leaves the machine, so a
 *  plaintext (or non-URL) scheme is rejected loudly rather than silently sent. */
export function resolveTelemetryEndpoint(input?: string): string {
  const trimmed = (input ?? '').trim();
  const endpoint = trimmed || DEFAULT_TELEMETRY_ENDPOINT;
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`telemetry endpoint is not a valid URL: ${endpoint}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`telemetry endpoint must use https (got ${parsed.protocol}//) — refusing ${endpoint}`);
  }
  return endpoint;
}

const INSTALL_ID_FILENAME = 'install-id';
const TELEMETRY_FILENAME = 'telemetry.json';

export interface TelemetryOptIn {
  enabled: boolean;
  endpoint: string;
}

/** Resolve the user config dir (overridable for tests). */
export function configDir(dir?: string): string {
  return dir ?? getUserConfigRoot();
}

/**
 * Return the anonymous install ID, generating and persisting it on first use.
 * Random and carrying nothing. Never throws — a config read/write failure falls
 * back to a fresh random UUID so telemetry can never block on local config I/O.
 */
export function getInstallId(dir?: string): string {
  const root = configDir(dir);
  const filePath = path.join(root, INSTALL_ID_FILENAME);
  try {
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, 'utf-8').trim();
      if (existing) return existing;
    }
    const id = randomUUID();
    mkdirSync(root, { recursive: true });
    writeFileSync(filePath, id + '\n', { mode: 0o600 });
    return id;
  } catch {
    return randomUUID();
  }
}

/** Read the telemetry opt-in. Any read failure is fail-closed (off, no endpoint). */
export function getTelemetryOptIn(dir?: string): TelemetryOptIn {
  const root = configDir(dir);
  const filePath = path.join(root, TELEMETRY_FILENAME);
  try {
    if (!existsSync(filePath)) return { enabled: false, endpoint: '' };
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    return {
      enabled: parsed?.enabled === true,
      endpoint: typeof parsed?.endpoint === 'string' ? parsed.endpoint : '',
    };
  } catch {
    return { enabled: false, endpoint: '' };
  }
}

/** Persist the telemetry opt-in. Throws on write failure (an explicit user action). */
export function setTelemetryOptIn(optIn: TelemetryOptIn, dir?: string): void {
  const root = configDir(dir);
  const filePath = path.join(root, TELEMETRY_FILENAME);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    filePath,
    JSON.stringify({ enabled: optIn.enabled === true, endpoint: optIn.endpoint ?? '' }, null, 2) + '\n',
    { mode: 0o600 },
  );
}

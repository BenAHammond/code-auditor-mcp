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

/**
 * Privacy statement shared by the tool, SKILL, and docs. Lists the exact eight
 * fields sent by an opted-in dismissal, matching the docs privacy page so the
 * CLI, MCP tool, and website never disagree about what leaves the machine.
 */
export const PRIVACY_MESSAGE =
  'Anonymous opt-in feedback: each submission contains the tool version, the rule ID, the urgency level, the dismissal reason exactly as typed, a structural AST signature (grammar node types only, never their contents), a coarse language hint, a timestamp, and an anonymous install ID generated locally on your machine. Source code, identifiers, literals, file paths, and environment details are never sent.';

/**
 * The default ingest endpoint (the operator's service). Shipped so opt-in is a
 * one-step toggle with a known destination; overridable at enable time and via
 * the CLI `--telemetry-endpoint` flag. It is a default, not a contract — a
 * domain can be pointed at the service later by changing this one value.
 */
export const DEFAULT_TELEMETRY_ENDPOINT =
  'https://code-auditor-dismissals.ben-a-hammond.workers.dev/ingest';

/**
 * Resolve the effective endpoint: an explicit non-blank value wins, else the shipped
 * default. The endpoint must be an https URL — telemetry leaves the machine, so a
 * plaintext (or non-URL) scheme is rejected loudly rather than silently sent.
 *
 * @param input - Optional explicit endpoint override.
 * @returns The resolved https endpoint.
 */
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
 *
 * @param dir - Optional config directory override (for tests).
 * @returns The anonymous install ID (generated and persisted on first use).
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

/**
 * Read the telemetry opt-in. Any read failure is fail-closed (off, no endpoint).
 *
 * @param dir - Optional config directory override (for tests).
 * @returns The opt-in state, defaulting to disabled with no endpoint.
 */
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

/**
 * Persist the telemetry opt-in. Throws on write failure (an explicit user action).
 *
 * @param optIn - The opt-in state to persist.
 * @param dir - Optional config directory override (for tests).
 */
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

/**
 * Whether the user has made an opt-in decision — i.e. a `telemetry.json` exists,
 * regardless of whether it records enabled or disabled. False means the user has
 * never been asked, so the installer/SKILL should offer the choice once.
 *
 * @param dir - Optional config directory override (for tests).
 * @returns True when a telemetry decision has been recorded.
 */
export function hasTelemetryDecision(dir?: string): boolean {
  return existsSync(path.join(configDir(dir), TELEMETRY_FILENAME));
}

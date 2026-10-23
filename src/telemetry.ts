/**
 * Spec 57 — opt-in dismissals telemetry.
 *
 * When the user dismisses a finding and has opted in, a small anonymized payload
 * is sent to the feedback service. The payload is *shape + decision*, never
 * code. The only code-derived field is the structural signature (`structuralSignature`),
 * which is built from grammar kinds alone — identifiers, string literals, table
 * names, paths, and source text are structurally impossible to include.
 *
 * The rules that make this safe and invisible to the gate:
 *
 *   - **opt-in** — nothing is sent unless the user opts in via one of three
 *     methods (the `telemetry` MCP tool, the `code-audit telemetry enable` command,
 *     the `CODE_AUDITOR_TELEMETRY` env var, or the per-invocation `--telemetry`
 *     flag — see `resolveTelemetryConfig`), and the payload is *printed before
 *     sending* so the user can review it.
 *   - **offline never blocks** — `sendTelemetry` is best-effort: any network error
 *     resolves to `{ sent: false }`, never throws, never affects the exit code.
 *   - **no content** — the payload type has no field for a path, identifier,
 *     literal, or source snippet, so none can leak by accident (acceptance 4).
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseFile } from './languages/adapterBridge.js';
import { signatureForLocation } from './structuralSignature.js';
import {
  getInstallId,
  getTelemetryOptIn,
  setTelemetryOptIn,
  hasTelemetryDecision,
  PRIVACY_MESSAGE,
  resolveTelemetryEndpoint,
  DEFAULT_TELEMETRY_ENDPOINT,
} from './installConfig.js';
import type { Severity } from './types.js';

// ── Payload ──────────────────────────────────────────────────────────────────

/**
 * The version of the telemetry *schema* — the payload shape itself — independent
 * of the tool version. This is the cross-repo contract with the feedback service
 * (`../services/src/index.ts`): both sides pin the same value, and a bump on one
 * side without the other is caught by each repo's pinned-shape test. The `v`
 * field below is the tool version, which changes every release while the schema
 * stays put — it is *not* a schema version and must not be used as one.
 */
export const TELEMETRY_SCHEMA_VERSION = 2;

/** The exact, minimal set of fields sent. Adding a field here is a security review. */
export interface TelemetryPayload {
  /** Payload schema version (the shape contract across repos), not the tool version. */
  schema: number;
  /** Anonymous install ID (random, generated locally) — groups submissions by source. */
  install_id: string;
  /** Tool version (package.json). */
  v: string;
  /** Canonical rule ID of the dismissed finding. */
  rule: string;
  /** Urgency level — critical | severe | high. */
  level: Severity;
  /** Dismissal reason, verbatim (the product — it is the human's words). */
  reason: string;
  /** Structural AST signature (grammar kinds only; no identifiers/literals). */
  signature: string;
  /** Coarse language/framework hint (e.g. `typescript`, `react`, `go`). */
  lang: string;
  /** ISO-8601 timestamp of the send. */
  ts: string;
}

// ── Language hint ────────────────────────────────────────────────────────────

/**
 * Coarse language/framework hint from a file path — never a path, just a class.
 *
 * @param filePath - The file path whose extension determines the hint.
 * @returns A coarse language/framework class (e.g. `typescript`, `react`, `go`).
 */
export function languageHint(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.tsx':
      return 'typescript-react';
    case '.jsx':
      return 'javascript-react';
    case '.ts':
      return 'typescript';
    case '.js':
      return 'javascript';
    case '.go':
      return 'go';
    default:
      return 'other';
  }
}

// ── Assembly ─────────────────────────────────────────────────────────────────

export interface TelemetryPayloadInput {
  install_id: string;
  toolVersion: string;
  rule: string;
  level: Severity;
  reason: string;
  signature: string;
  lang: string;
}

/**
 * Assemble the payload. Timestamp is stamped at build time.
 *
 * @param input - The payload fields (install ID, rule, level, reason, signature, lang).
 * @returns The complete telemetry payload with a fresh timestamp.
 */
export function buildTelemetryPayload(input: TelemetryPayloadInput): TelemetryPayload {
  return {
    schema: TELEMETRY_SCHEMA_VERSION,
    install_id: input.install_id,
    v: input.toolVersion,
    rule: input.rule,
    level: input.level,
    reason: input.reason,
    signature: input.signature,
    lang: input.lang,
    ts: new Date().toISOString(),
  };
}

/**
 * Human-readable preview, printed before any send so the user can review it.
 *
 * @param payload - The payload to render.
 * @returns A multi-line, human-readable preview string.
 */
export function formatTelemetryPreview(payload: TelemetryPayload): string {
  return [
    '',
    '── Telemetry payload (preview — review before sending) ──',
    `  schema:        ${payload.schema}`,
    `  install ID:    ${payload.install_id}`,
    `  tool version:  ${payload.v}`,
    `  rule:          ${payload.rule}`,
    `  urgency:       ${payload.level}`,
    `  reason:        ${payload.reason}`,
    `  signature:     ${payload.signature}`,
    `  language:      ${payload.lang}`,
    '  (no file paths, identifiers, literals, or source text are included)',
    '',
  ].join('\n');
}

// ── Config (opt-in) ──────────────────────────────────────────────────────────

export interface TelemetryConfig {
  enabled: boolean;
  /** Endpoint URL. Empty/absent → telemetry is a no-op (nothing to send to). */
  endpoint: string;
}

/**
 * Read the `CODE_AUDITOR_TELEMETRY` env override, if set. This is the middle
 * opt-in method: it sits above the persisted user config (so a headless/CI
 * machine can opt in without running the interactive `telemetry enable`) and
 * below the per-invocation `--telemetry` / `--no-telemetry` flag. Truthy values
 * are `1`/`true`/`on`/`yes`; falsy are `0`/`false`/`off`/`no`; anything else
 * (including unset) returns `undefined` — no override.
 *
 * @returns `true`/`false` for an explicit override, or `undefined` when the
 * variable is unset or unrecognised.
 */
export function telemetryEnvOverride(): boolean | undefined {
  const raw = process.env.CODE_AUDITOR_TELEMETRY;
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  return undefined;
}

/**
 * Resolve opt-in across the three opt-in methods, in precedence order:
 *
 *   1. per-invocation `opts.force` — the `--telemetry` / `--no-telemetry` flag;
 *   2. env var `CODE_AUDITOR_TELEMETRY` (machine-level default);
 *   3. persisted user config (`installConfig.ts`) — set by `telemetry enable`.
 *
 * `opts.endpoint` is a caller override (e.g. the local-dev `--telemetry-endpoint`
 * flag). When enabled resolves ON but no endpoint is configured — as with a bare
 * `--telemetry` or env-var opt-in — the shipped default endpoint is used so a
 * one-shot opt-in still has somewhere to send.
 *
 * @param opts - Optional endpoint override, config directory, and force flag.
 * @returns The resolved telemetry opt-in configuration.
 */
export function resolveTelemetryConfig(
  opts: { endpoint?: string; dir?: string; force?: boolean } = {},
): TelemetryConfig {
  const optIn = getTelemetryOptIn(opts.dir);
  const env = telemetryEnvOverride();

  let enabled = optIn.enabled;
  if (env !== undefined) enabled = env;
  if (opts.force !== undefined) enabled = opts.force;

  let endpoint = opts.endpoint ?? optIn.endpoint;
  if (enabled && !endpoint) endpoint = DEFAULT_TELEMETRY_ENDPOINT;

  return { enabled, endpoint };
}

// ── Send (best-effort, offline-safe) ─────────────────────────────────────────

export interface TelemetrySendResult {
  sent: boolean;
  error?: string;
}

/** Result of a `postJson` POST: the HTTP status plus any parsed JSON body. */
export interface JsonPostResult {
  /** HTTP status (0 when the request never completed — network error / timeout). */
  status: number;
  /** Whether the response was 2xx. */
  ok: boolean;
  /** Parsed JSON body, or `undefined` when there is none (or it isn't JSON). */
  body: unknown;
  /** Error description when the request never completed. */
  error?: string;
}

/**
 * Shared JSON POST helper — POST `body` as JSON to `url` with a timeout, and
 * return the HTTP status plus any parsed JSON body. A network error or timeout
 * resolves to `{ status: 0, ok: false, error }`; it never throws. This is the
 * single seam `sendTelemetry` (dismissal feedback) and the `request-rule` CLI
 * subcommand both POST through, so their timeout/parse behaviour stays in sync.
 *
 * @param url - The endpoint to POST to.
 * @param body - The JSON-serializable body.
 * @param opts - Optional timeout (default 5000ms) and extra headers.
 * @returns The status, ok flag, parsed body, and any transport error.
 */
export async function postJson(
  url: string,
  body: unknown,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<JsonPostResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    return { status: response.status, ok: response.ok, body: parsed };
  } catch (error) {
    clearTimeout(timer);
    return {
      status: 0,
      ok: false,
      body: undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Send a payload to the feedback service. Best-effort: a missing endpoint, a
 * network failure, a timeout, or a non-2xx response all resolve to
 * `{ sent: false }` and never throw — telemetry can never block or fail a gate.
 *
 * @param payload - The payload to send.
 * @param endpoint - The https endpoint to POST to.
 * @param opts - Optional timeout override.
 * @returns Whether the payload was sent, plus an optional error description.
 */
export async function sendTelemetry(
  payload: TelemetryPayload,
  endpoint: string,
  opts: { timeoutMs?: number } = {},
): Promise<TelemetrySendResult> {
  if (!endpoint) return { sent: false };

  const result = await postJson(endpoint, payload, { timeoutMs: opts.timeoutMs ?? 2000 });
  if (result.error) return { sent: false, error: result.error };
  if (!result.ok) return { sent: false, error: `HTTP ${result.status}` };
  return { sent: true };
}

// ── Opt-in control (status/enable/disable) ───────────────────────────────────

/** The shape returned by the telemetry status/enable/disable actions. */
export interface TelemetryStatus {
  enabled: boolean;
  endpoint: string;
  installId: string | null;
  decided: boolean;
  message: string;
}

/**
 * Report the current opt-in state. `installId` is only surfaced when enabled —
 * reading it when off would silently generate and persist an ID the user never
 * asked for.
 *
 * @param dir - Optional config directory override (for tests).
 * @returns Whether opt-in is enabled, its endpoint, the install ID, and the
 *   privacy message.
 */
export function telemetryStatus(dir?: string): TelemetryStatus {
  const optIn = getTelemetryOptIn(dir);
  return {
    enabled: optIn.enabled,
    endpoint: optIn.endpoint,
    installId: optIn.enabled ? getInstallId(dir) : null,
    decided: hasTelemetryDecision(dir),
    message: PRIVACY_MESSAGE,
  };
}

/**
 * Opt in. `endpointInput` defaults to the built-in service endpoint; a non-https
 * or non-URL value throws (telemetry leaves the machine, so it must be https).
 *
 * @param endpointInput - Optional ingest URL override.
 * @param dir - Optional config directory override (for tests).
 * @returns The now-enabled state, endpoint, fresh install ID, and privacy message.
 */
export function telemetryEnable(endpointInput?: string, dir?: string): TelemetryStatus {
  const endpoint = resolveTelemetryEndpoint(endpointInput);
  setTelemetryOptIn({ enabled: true, endpoint }, dir);
  return {
    enabled: true,
    endpoint,
    installId: getInstallId(dir),
    decided: true,
    message: PRIVACY_MESSAGE,
  };
}

/**
 * Opt out. The endpoint is remembered (nothing further is sent, but re-enabling
 * without an argument keeps the last endpoint).
 *
 * @param dir - Optional config directory override (for tests).
 * @returns The now-disabled state and the privacy message.
 */
export function telemetryDisable(dir?: string): { enabled: boolean; message: string } {
  const current = getTelemetryOptIn(dir);
  setTelemetryOptIn({ enabled: false, endpoint: current.endpoint }, dir);
  return { enabled: false, message: PRIVACY_MESSAGE };
}

// ── Signature from a finding ─────────────────────────────────────────────────

/**
 * Compute the structural signature for a finding at a file location. Reads the
 * file, parses it, and signs the shape at that location. Returns null when the
 * file can't be read/parsed or no node contains the location. Requires
 * `initParsers()` to have been called by the caller.
 *
 * @param filePath - File to read, parse, and sign.
 * @param line - 1-based line of the finding.
 * @param column - 1-based column of the finding.
 * @returns The structural signature, or null when read/parse/location fails.
 */
export function signatureForFinding(
  filePath: string,
  line: number,
  column: number,
): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, 'utf-8');
    const ast = parseFile(filePath, content);
    if (!ast) return null;
    const signature = signatureForLocation(ast, { line, column });
    ast.dispose?.();
    return signature;
  } catch {
    return null;
  }
}

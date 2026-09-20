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
 *   - **opt-in** — nothing is sent unless the user opts in via the `telemetry` MCP
 *     tool, and the payload is *printed before sending* so the user can review it.
 *   - **offline never blocks** — `sendTelemetry` is best-effort: any network error
 *     resolves to `{ sent: false }`, never throws, never affects the exit code.
 *   - **no content** — the payload type has no field for a path, identifier,
 *     literal, or source snippet, so none can leak by accident (acceptance 4).
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseFile } from './languages/adapterBridge.js';
import { signatureForLocation } from './structuralSignature.js';
import { getTelemetryOptIn } from './installConfig.js';
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

/** Coarse language/framework hint from a file path — never a path, just a class. */
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

/** Assemble the payload. Timestamp is stamped at build time. */
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

/** Human-readable preview, printed before any send so the user can review it. */
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
 * Resolve opt-in from the user-level config (see `installConfig.ts`): OFF unless
 * the user explicitly enabled it via the `telemetry` MCP tool. `opts.endpoint` is
 * a caller override (e.g. the local-dev `--telemetry-endpoint` flag).
 */
export function resolveTelemetryConfig(
  opts: { endpoint?: string; dir?: string } = {},
): TelemetryConfig {
  const optIn = getTelemetryOptIn(opts.dir);
  return {
    enabled: optIn.enabled,
    endpoint: opts.endpoint ?? optIn.endpoint,
  };
}

// ── Send (best-effort, offline-safe) ─────────────────────────────────────────

export interface TelemetrySendResult {
  sent: boolean;
  error?: string;
}

/**
 * Send a payload to the feedback service. Best-effort: a missing endpoint, a
 * network failure, a timeout, or a non-2xx response all resolve to
 * `{ sent: false }` and never throw — telemetry can never block or fail a gate.
 */
export async function sendTelemetry(
  payload: TelemetryPayload,
  endpoint: string,
  opts: { timeoutMs?: number } = {},
): Promise<TelemetrySendResult> {
  if (!endpoint) return { sent: false };

  const timeoutMs = opts.timeoutMs ?? 2000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      return { sent: false, error: `HTTP ${response.status}` };
    }
    return { sent: true };
  } catch (error) {
    clearTimeout(timer);
    return { sent: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ── Signature from a finding ─────────────────────────────────────────────────

/**
 * Compute the structural signature for a finding at a file location. Reads the
 * file, parses it, and signs the shape at that location. Returns null when the
 * file can't be read/parsed or no node contains the location. Requires
 * `initParsers()` to have been called by the caller.
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

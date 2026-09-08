/**
 * Spec 50 — shared daemon types.
 *
 * The daemon's core owns the store + pipeline; the LSP and Unix-socket faces are
 * thin adapters over it (R1). These types are the single contract both faces and
 * the resolution layer (`resolve.ts`) consume, so nothing analysis-related leaks
 * into an adapter.
 */

import type { Violation } from '../types.js';

/** Daemon lifecycle state (R1/R3). */
export type DaemonStatus =
  | 'starting'       // parsers loading, lease being claimed, discovery running
  | 'indexing'       // seed audit in flight
  | 'ready'          // seed complete; serving current findings
  | 'reindexing'     // a warm re-audit is in flight (still serving the last known-good set)
  | 'shutting-down'; // releasing lease, closing faces

/** Seed phases, in completion order. `retryAfterMs` prices each on its own rate. */
export type DaemonSeedPhase = 'files' | 'reducers' | 'derived' | 'finalize';

export interface DaemonProgress {
  filesIndexed: number;
  filesTotal: number;
  /** Source files (have a LanguageAdapter) — parsed first, priced at the source rate. */
  sourceTotal?: number;
  /** Orphan files (no adapter) — read last, priced at the orphan rate. */
  orphanTotal?: number;
  /** Which seed phase the daemon is in — visible so a caller watches phase, not a frozen file count. */
  phase: DaemonSeedPhase;
  /** Progress within the current phase (e.g. reducer 2/4). */
  phaseCurrent?: number;
  phaseTotal?: number;
}

/**
 * The answer every read surface gets for "what is the daemon's state" (R3).
 *
 * `retryAfterMs` is derived from observed progress across the seed's *whole*
 * lifetime — files, corpus reducers, derived reducers, and finalization — so it
 * covers time-to-ready, not just time-to-finish-files. Each phase is priced on
 * its own observed rate; at a phase boundary (rate not yet observed) the value
 * is clamped conservatively rather than collapsing to "done". When the first
 * files have not yet been indexed, throughput is unknown and `retryAfterMs` is
 * `null` with `throughputUnknown` set, so a client can distinguish "not ready,
 * wait ~N ms" from "not ready, we don't yet know how long" without parsing prose.
 */
export interface DaemonState {
  status: DaemonStatus;
  progress?: DaemonProgress;
  retryAfterMs: number | null;
  throughputUnknown: boolean;
}

/** Per-file diagnostics (Face A / Face B) — a violation plus its resolved range. */
export interface DaemonDiagnostic extends Violation {
  /** True when this file's findings could not be validated as current (R4). */
  stale?: boolean;
}

export interface DaemonDiagnosticsResult {
  status: DaemonStatus;
  diagnostics: DaemonDiagnostic[];
  /** R4 — files whose recorded hash no longer matches disk; findings not served. */
  staleFiles: string[];
}

export interface DaemonFindingsResult {
  status: DaemonStatus;
  violations: Violation[];
  /** R4 — files whose recorded hash no longer matches disk. */
  staleFiles: string[];
}

/** Wire protocol for the Unix socket face (Face B). Newline-delimited JSON. */
export type SocketMethod = 'status' | 'diagnostics' | 'findings' | 'shutdown';

export interface SocketRequest {
  id: number;
  method: SocketMethod;
  params: {
    /** File paths (absolute or project-relative) for `diagnostics`. */
    files?: string[];
  };
}

export interface SocketResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Spec 50 — `DaemonCore`: the daemon's heart. Owns the store and the pipeline
 * (R1); the LSP and Unix-socket faces are adapters over it.
 *
 * The core reuses the Spec 41 incremental machinery wholesale: `hashAndStatFiles`
 * / `diffFiles` / `splitFindings` / `mergeFindings` from `nextFileIncremental.ts`.
 * The seed is a full `runAuditDispatch` (the same entry `code-audit audit` uses,
 * so counts match — acceptance 10); a warm re-audit is a scoped dispatch merged
 * per-analyzer, exactly the `next-file` warm path made continuous.
 *
 * Concurrency (R5) uses the Spec 41 lease: a `findings_ledger_runs` row with
 * `status='running'`, PID + hostname + start-time, heartbeated. A second daemon
 * that cannot bind the socket (Face B) exits; a crashed daemon's lease is
 * reclaimed by the next start via `reclaimStaleRunning`.
 */

import { EventEmitter } from 'node:events';
import { watch, statSync, existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { runAuditDispatch } from '../auditRouter.js';
import { CodeIndexDB } from '../codeIndexDB.js';
import { PACKAGE_VERSION } from '../constants.js';
import {
  createLedgerRun,
  writeAuditToLedger,
  patchLedgerRun,
  hashFileSet,
  reclaimStaleRunning,
  type LedgerRunInput,
} from '../ledger.js';
import { findConfigFileUp, loadConfig } from '../config/configLoader.js';
import { discoverFilesDetailed, KNOWN_SOURCE_EXTENSIONS } from '../utils/fileDiscovery.js';
import { initParsers } from '../languages/index.js';
import {
  hashAndStatFiles,
  diffFiles,
  splitFindings,
  mergeFindings,
  type FileRecord,
  type NextFileSnapshot,
} from '../nextFileIncremental.js';
import type { AuditConfig, Violation } from '../types.js';
import {
  type DaemonStatus,
  type DaemonState,
  type DaemonDiagnosticsResult,
  type DaemonFindingsResult,
} from './types.js';

/** Extensions that carry table/DDL definitions — a change can shift the schema catalog. */
const SCHEMA_DEFINITION_EXTENSIONS = new Set(['.sql', '.prisma']);

/** Daemon lease TTL (longer than the 30s audit-job lease: a long-lived idle process). */
const DAEMON_LEASE_TTL_MS = Number(process.env.CODE_AUDITOR_DAEMON_LEASE_TTL_MS) || 60_000;

/** Debounce window for coalescing a burst of watcher events into one re-audit. */
const WATCH_DEBOUNCE_MS = 300;

/** Clamp for `retryAfterMs` so it is never absurdly short or long. */
const RETRY_AFTER_MIN_MS = 250;
const RETRY_AFTER_MAX_MS = 30_000;

export interface DaemonCoreOptions {
  projectRoot: string;
  configName?: string;
  idleTimeoutMs: number;
  /** Called whenever the observable state changes (indexing→ready, etc.). */
  onState?: (state: DaemonState) => void;
  /** Called whenever the findings set is updated (seed or warm re-audit). */
  onFindings?: (snapshot: NextFileSnapshot) => void;
}

export class DaemonCore extends EventEmitter {
  readonly projectRoot: string;
  private readonly configName?: string;
  private readonly idleTimeoutMs: number;

  private status: DaemonStatus = 'starting';
  private snapshot: NextFileSnapshot | null = null;
  private progress = { filesIndexed: 0, filesTotal: 0 };
  private seedStartedAt = 0;

  private db: CodeIndexDB | null = null;
  private leaseRunId: string | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private watcher: ReturnType<typeof watch> | null = null;
  private watchDebounce: NodeJS.Timeout | null = null;
  private pendingWatchPaths = new Set<string>();

  private reindexing = false;
  private lastActivityAt = Date.now();
  private activeConnections = 0;
  private shutdownRequested = false;
  private config: AuditConfig | null = null;

  constructor(options: DaemonCoreOptions) {
    super();
    this.projectRoot = path.resolve(options.projectRoot);
    this.configName = options.configName;
    this.idleTimeoutMs = options.idleTimeoutMs;
  }

  /** Called by each face when a client connects/disconnects (idle tracking). */
  registerConnection(): void {
    this.activeConnections++;
    this.markActivity();
  }
  unregisterConnection(): void {
    this.activeConnections = Math.max(0, this.activeConnections - 1);
    this.markActivity();
  }

  /** Faces call this on any client activity so the idle timer resets (R5). */
  markActivity(): void {
    this.lastActivityAt = Date.now();
  }

  getState(): DaemonState {
    const state: DaemonState = {
      status: this.status,
      retryAfterMs: null,
      throughputUnknown: false,
    };
    if (this.status === 'indexing' || this.status === 'reindexing') {
      state.progress = { ...this.progress };
      state.retryAfterMs = this.deriveRetryAfterMs();
      state.throughputUnknown = state.retryAfterMs === null;
    }
    return state;
  }

  /** R3/R6 — derive `retryAfterMs` from observed throughput, never a constant. */
  private deriveRetryAfterMs(): number | null {
    const elapsedSec = (Date.now() - this.seedStartedAt) / 1000;
    const { filesIndexed, filesTotal } = this.progress;
    if (filesIndexed <= 0 || elapsedSec <= 0) return null; // throughput unknown yet
    const throughput = filesIndexed / elapsedSec;
    const remaining = filesTotal - filesIndexed;
    if (throughput <= 0) return null;
    return Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, Math.round((remaining / throughput) * 1000)));
  }

  /** All current findings + R4 stale-file report. */
  getFindings(): DaemonFindingsResult {
    const staleFiles = this.checkStaleness();
    return {
      status: this.status,
      violations: this.snapshot ? flattenSnapshot(this.snapshot) : [],
      staleFiles,
    };
  }

  /** Per-file findings (diagnostics) + R4 staleness for those files. */
  getDiagnostics(files: string[]): DaemonDiagnosticsResult {
    const staleFiles = this.checkStaleness(files);
    const diagnostics = [];
    if (this.snapshot) {
      for (const file of files) {
        const key = path.relative(this.projectRoot, file);
        for (const v of this.snapshot.visitorFindings[key] ?? []) {
          diagnostics.push(v);
        }
      }
    }
    return { status: this.status, diagnostics, staleFiles };
  }

  /**
   * True if a watcher-flagged path belongs to the audited corpus (R5). The
   * watcher reports every change under the root — including the SQLite DB, WAL,
   * and SHM files this process writes to `node_modules/.cache` — so the
   * reconcile gate must filter to source extensions and never infra dirs, or a
   * single persist would re-audit the corpus and loop.
   */
  private isSourcePath(abs: string): boolean {
    const rel = path.relative(this.projectRoot, abs);
    if (!rel || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    const parts = rel.split(path.sep);
    if (parts.some((p) => p === 'node_modules' || p === '.git' || p === '.cache')) return false;
    return KNOWN_SOURCE_EXTENSIONS.includes(path.extname(abs).toLowerCase());
  }

  /**
   * R4 — validate that the served findings are current. Cheap-first: compare the
   * recorded mtime; only when it diverges (or the file is new/missing) is the
   * content re-hashed. `files` narrows the check to a specific read; `undefined`
   * checks the whole recorded set (count + newest mtime fast path, full hash on
   * divergence).
   */
  checkStaleness(files?: string[]): string[] {
    if (!this.snapshot) return [];
    const stale = new Set<string>();

    if (files && files.length > 0) {
      for (const file of files) {
        const abs = path.isAbsolute(file) ? file : path.join(this.projectRoot, file);
        const key = path.relative(this.projectRoot, abs);
        const rec = this.snapshot.files[key];
        try {
          const st = statSync(abs);
          if (rec && st.mtimeMs === rec.mtimeMs) continue; // mtime unchanged → current
          // mtime changed (or file is new): full hash to confirm.
          const hash = sha256(readFileSync(abs));
          if (!rec || hash !== rec.hash) stale.add(key);
        } catch {
          // Missing on disk: if we had recorded it, it's gone — stale; if never
          // recorded, it isn't ours to serve.
          if (rec) stale.add(key);
        }
      }
      return [...stale];
    }

    // Whole-set cheap pass (R4): stat each recorded file and compare its current
    // mtime to the snapshot's recorded mtime. Any divergence (or a missing file)
    // means the served set may be stale, so fall through to the full content-hash
    // diff. This is O(n) stat — no readFileSync — so the common "nothing changed"
    // read pays one stat per file, not one hash. A *content* change is always
    // reflected in the mtime of a normal write; the mtime-preserved case is the
    // job of the next-file `assertNoStaleFiles` gate, not this live read path.
    const recorded = this.snapshot.files;
    const rels = Object.keys(recorded);
    let diverged = false;
    for (const rel of rels) {
      try {
        const st = statSync(path.join(this.projectRoot, rel));
        if (st.mtimeMs !== recorded[rel].mtimeMs) {
          diverged = true;
          break;
        }
      } catch {
        stale.add(rel); // missing on disk
        diverged = true;
      }
    }
    if (diverged || stale.size > 0) {
      const current = hashAndStatFiles(rels.map((r) => path.join(this.projectRoot, r)), this.projectRoot);
      const diff = diffFiles(recorded, current);
      for (const rel of [...diff.changed, ...diff.deleted]) stale.add(rel);
    }
    return [...stale];
  }

  /** Start: init parsers, claim the lease, seed, watch. Resolves once seed completes. */
  async start(): Promise<void> {
    this.status = 'starting';
    await initParsers();

    const configPath = await findConfigFileUp(this.projectRoot);
    // Mirror the runner (`auditRunner.run`): load project config only when a
    // `.codeauditor.json` exists. Loading defaults here would normalize their
    // `includePaths`/`excludePaths` globs against *this process's* cwd (the
    // install dir), not the served project — the seed would then discover zero
    // files (R4's file-set hash would be empty) even though the pipeline's own
    // discovery (defaults against the project root) finds the corpus.
    this.config = configPath ? await loadConfig({ configPath }) : null;
    this.db = CodeIndexDB.getInstance(undefined, this.projectRoot);
    await this.db.initialize();

    this.claimLease();
    this.startIdleTimer();

    await this.seed();

    this.status = 'ready';
    this.markActivity();
    this.emitState();
    this.startWatcher();
  }

  private claimLease(): void {
    if (!this.db) return;
    // Reclaim any stale daemon lease from a prior crashed instance (R5).
    try {
      reclaimStaleRunning(this.db.rawDb, this.projectRoot, DAEMON_LEASE_TTL_MS);
    } catch {
      // best-effort — the socket bind is the primary exclusivity guard.
    }

    const runInput: LedgerRunInput = {
      gitDirty: false,
      toolVersion: PACKAGE_VERSION,
      command: 'daemon',
      surface: 'daemon',
      scope: 'all',
      target: this.projectRoot,
    };
    this.leaseRunId = createLedgerRun(this.db.rawDb, runInput, {
      status: 'running',
      projectRoot: this.projectRoot,
    });
    const now = new Date().toISOString();
    patchLedgerRun(this.db.rawDb, this.leaseRunId, {
      startedAt: now,
      heartbeatAt: now,
      runnerPid: process.pid,
      runnerPidStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      runnerHost: hostname(),
    });

    const heartbeatMs = Math.max(5000, Math.floor(DAEMON_LEASE_TTL_MS / 3));
    this.heartbeat = setInterval(() => {
      try {
        if (this.leaseRunId && this.db) {
          patchLedgerRun(this.db.rawDb, this.leaseRunId, { heartbeatAt: new Date().toISOString() });
        }
      } catch {
        // best-effort heartbeat
      }
    }, heartbeatMs);
    this.heartbeat.unref?.();
  }

  private startIdleTimer(): void {
    this.idleTimer = setInterval(() => this.checkIdle(), 1000);
    this.idleTimer.unref?.();
  }

  private checkIdle(): void {
    if (this.shutdownRequested) return;
    if (this.activeConnections > 0) return;
    if (this.status !== 'ready') return;
    if (Date.now() - this.lastActivityAt < this.idleTimeoutMs) return;
    void this.shutdown('idle timeout');
  }

  private async seed(): Promise<void> {
    this.status = 'indexing';
    this.seedStartedAt = Date.now();
    this.markActivity();

    const discovered = await discoverFilesDetailed(this.projectRoot, {
      includePaths: this.config?.includePaths,
      excludePaths: this.config?.excludePaths,
    });
    this.progress = { filesIndexed: 0, filesTotal: discovered.files.length };
    this.emitState();

    const start = Date.now();
    const result = await runAuditDispatch({
      projectRoot: this.projectRoot,
      configName: this.configName,
      progressCallback: (p) => {
        // Only the file-parse/analysis phases (stage1/stage2) report a true
        // file-level numerator; the index/schema phases report unrelated totals
        // (a style-index sync can report 1/1, a schema pass 0/3) that would make
        // the bar regress. Take a monotonic max so `filesIndexed` never drops,
        // and keep the discovery-derived `filesTotal` as the denominator.
        if (p.phase !== 'stage1' && p.phase !== 'stage2') return;
        this.progress.filesIndexed = Math.max(this.progress.filesIndexed, p.current ?? 0);
        this.emitState();
      },
    });
    const durationMs = Date.now() - start;

    const split = splitFindings(result.analyzerResults, this.projectRoot);
    const files = hashAndStatFiles(discovered.files, this.projectRoot);
    this.snapshot = {
      version: 1,
      projectRoot: this.projectRoot,
      files,
      visitorFindings: split.visitorFindings,
      corpusFindings: split.corpusFindings,
      schemaFindings: split.schemaFindings,
    };
    this.persistCurrent(flattenSnapshot(this.snapshot), durationMs);
  }

  /** Persist the current findings to the ledger (durable snapshot for the CLI). */
  private persistCurrent(violations: Violation[], durationMs: number): void {
    if (!this.db) return;
    const runInput: LedgerRunInput = {
      gitDirty: false,
      toolVersion: PACKAGE_VERSION,
      command: 'daemon-audit',
      surface: 'daemon',
      scope: 'all',
      target: this.projectRoot,
    };
    const runId = writeAuditToLedger(this.db.rawDb, runInput, violations, durationMs, 0);
    if (this.snapshot) {
      const fsh = hashFileSet(
        Object.keys(this.snapshot.files).map((r) => path.join(this.projectRoot, r)),
        this.projectRoot,
      );
      patchLedgerRun(this.db.rawDb, runId, {
        contentHash: fsh.contentHash,
        filesCount: fsh.filesCount,
        fileManifestJson: JSON.stringify(fsh.manifest),
      });
      if (this.leaseRunId) {
        patchLedgerRun(this.db.rawDb, this.leaseRunId, {
          contentHash: fsh.contentHash,
          filesCount: fsh.filesCount,
          fileManifestJson: JSON.stringify(fsh.manifest),
        });
      }
    }
  }

  private startWatcher(): void {
    try {
      this.watcher = watch(this.projectRoot, { recursive: true }, (eventType, filename) => {
        if (!filename) return; // unknown change — R4 read-time check is the backstop
        const abs = path.join(this.projectRoot, filename.toString());
        // Ignore infra/non-source noise before it counts as activity or queues a
        // reconcile. The daemon's own heartbeat writes the lease row into the
        // SQLite DB under `node_modules/.cache` every ~20s; without this filter
        // that would (a) reset the idle timer forever and (b) re-audit on every
        // heartbeat. Only a source-path change is a corpus change.
        if (!this.isSourcePath(abs)) return;
        this.markActivity();
        this.pendingWatchPaths.add(abs);
        if (this.watchDebounce) clearTimeout(this.watchDebounce);
        this.watchDebounce = setTimeout(() => void this.reconcile(), WATCH_DEBOUNCE_MS);
        this.watchDebounce.unref?.();
      });
    } catch {
      // Linux < 20 (or other) may not support recursive watch; the R4 read-time
      // staleness check remains the correctness backstop. Log and continue.
      console.error('[code-auditor-daemon] recursive fs.watch unavailable; relying on read-time staleness');
    }
  }

  /** Warm re-audit of the files the watcher flagged. */
  private async reconcile(): Promise<void> {
    if (this.shutdownRequested || !this.snapshot) return;
    const paths = [...this.pendingWatchPaths];
    this.pendingWatchPaths.clear();
    if (paths.length === 0) return;
    if (this.reindexing) {
      // A reconcile is already running — requeue and it will pick these up via
      // the next diff, or via read-time staleness.
      return;
    }

    this.reindexing = true;
    const prevStatus = this.status;
    this.status = 'reindexing';
    this.emitState();
    this.markActivity();

    try {
      // Classify each affected path as changed/added/deleted against the record.
      const changed: string[] = [];
      const added: string[] = [];
      const deleted: string[] = [];
      const freshFiles: Record<string, FileRecord> = {};
      for (const abs of paths) {
        // R5 — the watcher sees *everything* under the root, including the
        // SQLite DB + WAL/SHM files this daemon writes to `node_modules/.cache`.
        // A bare "something changed" signal would re-audit (near the full
        // corpus) on every persist and loop. Only source paths are a corpus
        // change; drop infra + non-source noise before classification.
        if (!this.isSourcePath(abs)) continue;
        const key = path.relative(this.projectRoot, abs);
        const rec = this.snapshot.files[key];
        if (!existsSync(abs)) {
          if (rec) deleted.push(key);
          continue;
        }
        const rec2 = hashAndStatFiles([abs], this.projectRoot);
        const entry = rec2[key];
        if (!entry) continue;
        freshFiles[key] = entry;
        if (!rec) added.push(key);
        else if (rec.hash !== entry.hash) changed.push(key);
      }
      // Update the recorded file set for the affected files.
      for (const key of Object.keys(freshFiles)) this.snapshot.files[key] = freshFiles[key];
      for (const key of deleted) delete this.snapshot.files[key];

      if (changed.length === 0 && added.length === 0 && deleted.length === 0) {
        return;
      }

      const scopeFiles = [...changed, ...added].map((r) => path.join(this.projectRoot, r));
      const start = Date.now();
      const result = await runAuditDispatch({
        projectRoot: this.projectRoot,
        configName: this.configName,
        scope: scopeFiles.length > 0 ? scopeFiles : undefined,
      });
      const durationMs = Date.now() - start;

      const fresh = splitFindings(result.analyzerResults, this.projectRoot);

      // Schema-catalog hazard (mirrors next-file): a scoped run rebuilds the
      // known-tables catalog from only the changed files, so a table-definition
      // change can falsely flag unchanged query files `unknown-table`. Escalate
      // to a full re-seed rather than serve silently-wrong schema findings.
      const schemaCatalogTouched = (result.metadata?.tableCatalog?.length ?? 0) > 0;
      const schemaDefinitionChanged = [...changed, ...added, ...deleted].some((rel) =>
        SCHEMA_DEFINITION_EXTENSIONS.has(rel.slice(rel.lastIndexOf('.'))),
      );
      if (schemaCatalogTouched || schemaDefinitionChanged) {
        await this.seed();
        this.emitFindings();
        return;
      }

      const merged = mergeFindings({
        cachedVisitor: this.snapshot.visitorFindings,
        freshVisitor: fresh.visitorFindings,
        cachedCorpus: this.snapshot.corpusFindings,
        freshCorpus: fresh.corpusFindings,
        // Schema findings are fact-based and rebuilt from a full corpus; a scoped
        // run only sees the changed files' facts, so its schema output is partial.
        // Preserve the cached set (mirrors `runNextFile`) — the escalation above
        // already re-seeded when a schema-definition file changed.
        freshSchema: this.snapshot.schemaFindings,
        changed,
        added,
        deleted,
      });
      this.snapshot.visitorFindings = merged.visitorFindings;
      this.snapshot.corpusFindings = merged.corpusFindings;
      this.snapshot.schemaFindings = merged.schemaFindings;

      this.persistCurrent(flattenSnapshot(this.snapshot), durationMs);
      this.emitFindings();
    } finally {
      this.reindexing = false;
      if (!this.shutdownRequested) this.status = prevStatus;
      this.markActivity();
      this.emitState();
    }
  }

  private emitState(): void {
    const state = this.getState();
    this.emit('state', state);
  }

  private emitFindings(): void {
    if (this.snapshot) this.emit('findings', this.snapshot);
  }

  async shutdown(reason = 'shutdown'): Promise<void> {
    if (this.shutdownRequested) return;
    this.shutdownRequested = true;
    this.status = 'shutting-down';
    this.emitState();

    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    if (this.watcher) this.watcher.close();
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.idleTimer) clearInterval(this.idleTimer);

    if (this.db && this.leaseRunId) {
      try {
        patchLedgerRun(this.db.rawDb, this.leaseRunId, {
          status: 'completed',
          finishedAt: new Date().toISOString(),
        });
      } catch {
        // best-effort
      }
    }
    this.emit('shutdown', reason);
  }
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function flattenSnapshot(s: NextFileSnapshot): Violation[] {
  return [
    ...Object.values(s.visitorFindings).flat(),
    ...s.corpusFindings,
    ...s.schemaFindings,
  ];
}

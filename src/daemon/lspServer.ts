/**
 * Spec 50 — Face A: the LSP server over stdio.
 *
 * Editors attach to the daemon as a language server. This adapter contains no
 * analysis — it translates `DaemonCore` state/findings into LSP diagnostics,
 * pull responses, and a status notification (R1: the same core serves both
 * faces; the LSP face and the Unix-socket face cannot drift because neither
 * knows anything about the pipeline).
 *
 * Model:
 *   - `initialize` returns capabilities immediately (no blocking on the seed —
 *     a 4,000-file seed must not exceed the client's initialize timeout).
 *   - Indexing is reported via a `$/code-auditor/status` notification carrying
 *     the full `DaemonState` (status + progress + `retryAfterMs`), which the
 *     client renders as a status-bar indicator (R6).
 *   - Findings are served per-file (the `visitorFindings` in the snapshot) both
 *     as push (`textDocument/publishDiagnostics` on every findings update and
 *     document open/save) and pull (`textDocument/diagnostic`).
 *   - R4: a stale file (edited behind the watcher) gets its diagnostics cleared
 *     rather than re-served; the next reconcile repopulates them.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  DiagnosticSeverity,
  DocumentDiagnosticReportKind,
  type Connection,
  type InitializeParams,
  type InitializeResult,
  type ServerCapabilities,
  type Range,
  type Diagnostic,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { PACKAGE_VERSION } from '../constants.js';
import type { DaemonCore } from './core.js';
import type { DaemonState } from './types.js';
import type { Severity, Violation } from '../types.js';

/** Server→client notification carrying the daemon's observable state (R6). */
const STATUS_NOTIFICATION = '$/code-auditor/status';

export interface LspFaceOptions {
  core: DaemonCore;
  /** Log lifecycle lines to stderr (foreground) instead of running silent. */
  foreground?: boolean;
}

export class LspFace {
  private readonly core: DaemonCore;
  private readonly foreground: boolean;
  private readonly connection: Connection;
  private readonly documents: TextDocuments<TextDocument>;
  /** URI → absolute file path for currently-open documents. */
  private readonly openDocs = new Map<string, string>();
  private started = false;

  constructor(options: LspFaceOptions) {
    this.core = options.core;
    this.foreground = !!options.foreground;
    // Explicit stdio streams: the daemon is spawned by the editor with piped
    // stdio, and nothing else may write to stdout (responses) — logging goes to
    // stderr via `console.error`. This also sidesteps createConnection's
    // command-line transport sniffing (`--stdio`/`--node-ipc`/`--socket`).
    this.connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
    this.documents = new TextDocuments(TextDocument);
    this.documents.listen(this.connection);
    this.registerHandlers();
  }

  private log(line: string): void {
    if (this.foreground) console.error(`[code-auditor-lsp] ${line}`);
  }

  private registerHandlers(): void {
    this.connection.onInitialize((params) => this.onInitialize(params));
    this.connection.onInitialized(() => this.onInitialized());
    this.connection.onShutdown(() => this.log('shutdown requested'));
    this.connection.onExit(() => void this.core.shutdown('lsp exit'));

    this.connection.onDidChangeWatchedFiles(() => {
      // The core's filesystem watcher already reconciles on change; this is the
      // LSP-level echo of the same signal — mark activity so the idle timer
      // never fires mid-edit, and republish once the watcher settles.
      this.core.markActivity?.();
      this.publishDiagnostics();
    });

    this.documents.onDidOpen((e) => {
      this.openDocs.set(e.document.uri, fileURLToPath(e.document.uri));
      this.core.markActivity?.();
      this.publishDiagnostics();
    });
    this.documents.onDidSave((e) => {
      this.core.markActivity?.();
      this.publishDiagnostics();
    });
    this.documents.onDidClose((e) => {
      this.openDocs.delete(e.document.uri);
      this.connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
    });

    // Pull model (textDocument/diagnostic) — mirror of the push path.
    this.connection.languages.diagnostics.on(async (params) => {
      const abs = fileURLToPath(params.textDocument.uri);
      const items = this.diagnosticsForFile(abs);
      return { kind: DocumentDiagnosticReportKind.Full, items };
    });

    // Core → face: republish on every state and findings transition.
    this.core.on('state', (state: DaemonState) => this.onState(state));
    this.core.on('findings', () => this.publishDiagnostics());
  }

  private onInitialize(_params: InitializeParams): InitializeResult {
    const capabilities: ServerCapabilities = {
      // Track open/close so we know which documents to push diagnostics for,
      // but never sync content — the daemon reads files off disk.
      textDocumentSync: { openClose: true, change: TextDocumentSyncKind.None },
      diagnosticProvider: {
        interFileDependencies: false,
        workspaceDiagnostics: false,
      },
    };
    return {
      capabilities,
      serverInfo: { name: 'code-auditor-daemon', version: PACKAGE_VERSION },
    };
  }

  private onInitialized(): void {
    // An attached editor keeps the daemon alive (blocks the idle timeout).
    this.core.registerConnection();
    this.log(`attached; project ${this.core.projectRoot}`);
    this.connection.sendNotification(STATUS_NOTIFICATION, this.core.getState());
    this.publishDiagnostics();
  }

  private onState(state: DaemonState): void {
    this.connection.sendNotification(STATUS_NOTIFICATION, state);
  }

  /** R4-aware per-file diagnostics: stale files clear rather than re-serve. */
  private diagnosticsForFile(abs: string): Diagnostic[] {
    const result = this.core.getDiagnostics([abs]);
    if (result.staleFiles.length > 0) return [];
    return result.diagnostics.map(violationToDiagnostic);
  }

  /** Push diagnostics for every open document from the live snapshot. */
  private publishDiagnostics(): void {
    for (const [uri, abs] of this.openDocs) {
      this.connection.sendDiagnostics({ uri, diagnostics: this.diagnosticsForFile(abs) });
    }
  }

  /** Start reading stdio. Handlers are registered before this so no message races. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.connection.listen();
  }

  /** The process exits via `finish()` in `main.ts`; there is nothing to unwind. */
  stop(): void {
    // no-op — `TextDocuments` owns no resources beyond the connection, which
    // `finish()` tears down by exiting the process.
  }
}

/** Map a violation's 1-based line/column to a 0-based LSP `Range`. */
function violationToDiagnostic(v: Violation): Diagnostic {
  const line = Math.max(0, (v.line ?? 1) - 1);
  const character = Math.max(0, (v.column ?? 1) - 1);
  // No reliable end position on violations — highlight the start token.
  const range: Range = {
    start: { line, character },
    end: { line, character: character + 1 },
  };
  const message = v.suggestion ? `${v.message}\n\nSuggestion: ${v.suggestion}` : v.message;
  return {
    range,
    severity: severityToDiagnosticSeverity(v.severity),
    code: v.rule || v.type || 'code-auditor',
    source: 'code-auditor',
    message,
  };
}

function severityToDiagnosticSeverity(s: Severity): DiagnosticSeverity {
  switch (s) {
    case 'critical':
      return DiagnosticSeverity.Error;
    case 'warning':
      return DiagnosticSeverity.Warning;
    case 'suggestion':
      return DiagnosticSeverity.Hint;
    default:
      return DiagnosticSeverity.Information;
  }
}

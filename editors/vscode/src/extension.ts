/**
 * Spec 50 — the reference VS Code client (Face A's thin editor half).
 *
 * The daemon is the language server; this extension is only the launch + status
 * glue. It spawns `code-auditor-daemon --lsp <workspace>` over stdio and lets
 * `vscode-languageclient` speak LSP for diagnostics (`textDocument/
 * publishDiagnostics` and `textDocument/diagnostic` pull). The one thing the
 * client owns that the protocol does not express is R6's status: it subscribes
 * to the server's `$/code-auditor/status` notification (the full `DaemonState`)
 * and renders indexing progress in the status bar so R3's "not ready" never
 * reads as a hang.
 */

import * as vscode from 'vscode';
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;
let statusBar: vscode.StatusBarItem | undefined;

/** `DaemonState` as pushed by the server — see `src/daemon/types.ts`. */
interface DaemonState {
  status: 'starting' | 'indexing' | 'ready' | 'reindexing' | 'shutting-down';
  progress?: { filesIndexed: number; filesTotal: number };
  retryAfterMs: number | null;
  throughputUnknown: boolean;
}

export function activate(context: vscode.ExtensionContext): void {
  if (!vscode.workspace.getConfiguration('codeAuditor').get<boolean>('enable', true)) {
    return;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);

  if (!workspaceFolder) {
    statusBar.text = '$(warning) Code Auditor: no workspace folder';
    statusBar.show();
    return;
  }

  const config = vscode.workspace.getConfiguration('codeAuditor');
  const command = config.get<string>('daemonCommand', 'code-auditor-daemon');
  const extraArgs = config.get<string[]>('args', ['--lsp']);

  // The daemon owns both faces (R1); we ask it for the LSP face. The workspace
  // folder path is the project root the daemon indexes and watches.
  const serverOptions: ServerOptions = {
    run: { command, args: [...extraArgs, workspaceFolder.uri.fsPath] },
    debug: { command, args: ['--foreground', ...extraArgs, workspaceFolder.uri.fsPath] },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'typescript' },
      { scheme: 'file', language: 'javascript' },
      { scheme: 'file', language: 'typescriptreact' },
      { scheme: 'file', language: 'javascriptreact' },
      { scheme: 'file', language: 'go' },
    ],
    synchronize: {
      // Let the daemon's filesystem watcher do the real work; this only ensures
      // the client survives a config change without a full reload.
      configurationSection: 'codeAuditor',
    },
  };

  client = new LanguageClient(
    'codeAuditor',
    'Code Auditor',
    serverOptions,
    clientOptions,
  );

  client.onNotification('$/code-auditor/status', (state: DaemonState) => {
    renderStatus(state);
  });

  statusBar.text = '$(sync~spin) Code Auditor: starting…';
  statusBar.show();

  client.start().then(
    () => context.subscriptions.push(client!),
    (err) => {
      statusBar!.text = '$(error) Code Auditor: failed to start';
      statusBar!.tooltip = String(err);
      statusBar!.show();
      void vscode.window.showErrorMessage(
        `Code Auditor daemon failed to start. Is \`${command}\` on PATH? (${String(err)})`,
      );
    },
  );
}

function renderStatus(state: DaemonState): void {
  if (!statusBar) return;
  switch (state.status) {
    case 'indexing':
    case 'reindexing': {
      const n = state.progress?.filesIndexed ?? 0;
      const t = state.progress?.filesTotal ?? 0;
      statusBar.text = `$(sync~spin) Code Auditor: indexing ${n}/${t}`;
      statusBar.tooltip =
        state.retryAfterMs != null
          ? `Indexing… ready in ~${Math.max(1, Math.round(state.retryAfterMs / 1000))}s`
          : 'Indexing…';
      break;
    }
    case 'ready':
      statusBar.text = '$(check) Code Auditor';
      statusBar.tooltip = 'Findings are current';
      break;
    case 'shutting-down':
      statusBar.text = '$(circle-slash) Code Auditor: stopped';
      statusBar.tooltip = 'The daemon has shut down';
      break;
    default:
      statusBar.text = '$(sync~spin) Code Auditor: starting…';
      statusBar.tooltip = 'Starting…';
  }
  statusBar.show();
}

export function deactivate(): Thenable<void> | undefined {
  return client ? client.stop() : undefined;
}

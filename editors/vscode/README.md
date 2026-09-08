# Code Auditor — VS Code extension

The reference editor client for [Code Auditor](https://github.com/BenAHammond/code-auditor-mcp)'s
daemon (Spec 50). This extension is deliberately thin: the daemon is the language
server, and this extension only launches it and surfaces indexing status. All
analysis lives in the daemon, so every editor gets the same findings.

## How it works

- On activation it spawns `code-auditor-daemon --lsp <workspace-root>` over
  stdio. That process is the daemon — it seeds the index, watches the
  filesystem, and re-audits on change.
- Diagnostics (per-file findings) arrive via LSP `textDocument/publishDiagnostics`
  and `textDocument/diagnostic`; `vscode-languageclient` renders them as
  squiggles and Problems-panel entries with no extra work.
- Indexing progress is shown in the status bar, driven by the daemon's
  `$/code-auditor/status` notification (`indexing N/M`, `ready`), so a cold
  start never looks like a hang (Spec 50 R3/R6).

## Prerequisites

The daemon must be launchable on `PATH`:

```bash
npm install -g code-auditor-mcp   # provides the `code-auditor-daemon` bin
```

Or point the extension at a local build:

```jsonc
// settings.json
{
  "codeAuditor.daemonCommand": "/absolute/path/to/code-auditor/app/dist/daemon/main.js"
}
```

## Build & run

```bash
cd editors/vscode
npm install
npm run compile
```

Then open this folder in VS Code and press **F5** (Run Extension) to launch an
Extension Development Host.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `codeAuditor.enable` | `true` | Master switch. |
| `codeAuditor.daemonCommand` | `code-auditor-daemon` | Command (or absolute path) that launches the daemon. |
| `codeAuditor.args` | `["--lsp"]` | Extra args passed before the workspace path. |

## Notes

- The daemon binds a Unix socket for agents/CLI too (`code-audit daemon status`),
  so a single running daemon serves both the editor and any agent hooks.
- The daemon exits after 5 minutes idle (configurable via `daemon.idleTimeoutMs`);
  an editor reconnect restarts it.

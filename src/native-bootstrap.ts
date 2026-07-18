/**
 * native-bootstrap.ts
 *
 * Sets NAPI_RS_NATIVE_LIBRARY_PATH before any module imports @ast-grep/napi.
 *
 * npm cli#4828 prevents platform-specific optionalDependencies from installing
 * on stock npm. Our mitigation: we ship bundled .node files for all supported
 * platforms in dist/native/. This module detects the current platform and points
 * the @ast-grep/napi loader at the correct bundled binary.
 *
 * This file MUST be the FIRST import in every entry point (cli.ts, mcp.ts).
 * It imports only Node.js built-ins — nothing that could pull in @ast-grep/napi.
 */

import { platform, arch } from 'node:process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

// ── Musl detection (same logic as @ast-grep/napi's isMusl) ──────────────────

function isMusl(): boolean {
  if (platform !== 'linux') return false;

  // Approach 1: check /usr/bin/ldd
  try {
    if (readFileSync('/usr/bin/ldd', 'utf-8').includes('musl')) return true;
  } catch { /* not found */ }

  // Approach 2: spawn ldd --version
  try {
    const out = execSync('ldd --version', { encoding: 'utf8', timeout: 2000 });
    if (out.includes('musl')) return true;
  } catch { /* not found or timed out */ }

  return false;
}

// ── Platform → binding name mapping ────────────────────────────────────────

function getBindingFileName(): string | null {
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'ast-grep-napi.darwin-arm64.node';
    if (arch === 'x64') return 'ast-grep-napi.darwin-x64.node';
  }
  if (platform === 'win32') {
    if (arch === 'x64') return 'ast-grep-napi.win32-x64-msvc.node';
  }
  if (platform === 'linux') {
    const musl = isMusl();
    if (arch === 'x64') return musl ? 'ast-grep-napi.linux-x64-musl.node' : 'ast-grep-napi.linux-x64-gnu.node';
    if (arch === 'arm64') return musl ? 'ast-grep-napi.linux-arm64-musl.node' : 'ast-grep-napi.linux-arm64-gnu.node';
  }
  return null;
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

function bootstrapNativeBinding(): void {
  // User override always wins — if they set it, don't touch
  if (process.env.NAPI_RS_NATIVE_LIBRARY_PATH) return;

  const bindingName = getBindingFileName();
  if (!bindingName) return;

  // Resolve relative to this module's directory (dist/)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const bundledPath = join(__dirname, 'native', bindingName);

  if (existsSync(bundledPath)) {
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH = bundledPath;
  }
}

bootstrapNativeBinding();

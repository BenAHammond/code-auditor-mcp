/**
 * Spec 50 — live seed transcript. Subscribes to the daemon's `state` events (the
 * same stream the socket face serializes to a polling client) and prints one
 * line per phase transition plus each reducer/derived step, so R3's "reducer
 * phase visible" and "retryAfterMs never collapses to the 250ms floor while a
 * later phase is still running" are demonstrated on a real seed.
 *
 * Usage:
 *   cd /Users/ben/playground/code-auditor/app
 *   CODE_AUDITOR_DATA_DIR=/tmp/code-auditor-seed-transcript \
 *     npx tsx scripts/daemon-seed-transcript.ts /path/to/corpus
 */
import { DaemonCore } from '../src/daemon/core.js';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: daemon-seed-transcript.ts <projectRoot>');
  process.exit(2);
}

async function main() {
  const core = new DaemonCore({ projectRoot, idleTimeoutMs: 60_000 });
  const t0 = Date.now();
  let lastPhase = '';
  let lastStep = -1;

  const line = (s: ReturnType<DaemonCore['getState']>) => {
    const p = s.progress;
    const retry = s.retryAfterMs === null ? 'unknown' : `${s.retryAfterMs}ms`;
    return `${((Date.now() - t0) / 1000).toFixed(1)}s  status=${s.status}  ` +
      `phase=${p?.phase ?? '-'}  ${p?.phaseCurrent ?? 0}/${p?.phaseTotal ?? 0}  ` +
      `files=${p?.filesIndexed ?? 0}/${p?.filesTotal ?? 0}  retryAfterMs=${retry}`;
  };

  core.on('state', (s) => {
    const p = s.progress;
    const phase = p?.phase ?? s.status;
    const step = p?.phaseCurrent ?? 0;
    if (phase !== lastPhase || (p?.phase !== 'files' && step !== lastStep)) {
      console.log(line(s));
      lastPhase = phase;
      lastStep = step;
    }
  });

  // Await the full start (seed + watcher) before shutting down, so shutdown
  // cannot race `startWatcher` (which runs after the seed resolves).
  await core.start();
  await core.shutdown('transcript done');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});

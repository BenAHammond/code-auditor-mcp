/**
 * Spec 35 item 5 (A2) — prove the WASM tree is released on the visitor throw path.
 *
 * The dispose call site lives in a `finally` inside the stage-2 per-file loop
 * (pipeline.ts:364-372). This test fault-injects a visitor that throws on a
 * known file and asserts three things:
 *
 *   1. The tree is released — `dispose` runs on the throwing file's tuple too.
 *   2. The run continues — the non-throwing file is still visited.
 *   3. The failure is recorded per Spec 32 item 1 — it lands in `result.errors`,
 *      never swallowed.
 */

import { describe, it, expect, vi } from 'vitest';
import { runStage2 } from './pipeline.js';
import type { FileASTTuple, PipelineConfig, Stage2Visitor } from './types.js';

function makeVisitor(throwsOn: string | null): Stage2Visitor {
  return {
    name: 'throwing',
    stage: 'visitor',
    async visit(_ast, _adapter, context) {
      if (context.filePath === throwsOn) {
        throw new Error('injected visitor fault');
      }
      return { violations: [], facts: {}, indexFacts: [] };
    },
    getRuleIds: () => [],
    defaultConfig: {},
    description: 'fault-injection visitor',
    category: 'test',
  };
}

function tuple(file: string, dispose: () => void): FileASTTuple {
  return {
    kind: 'parsed',
    file,
    ast: { dispose },
    adapter: null,
    sourceCode: 'let x = 1;',
  };
}

async function* stream(tuples: FileASTTuple[]): AsyncGenerator<FileASTTuple> {
  for (const t of tuples) yield t;
}

describe('stage-2 dispose on the visitor throw path (Spec 35 A2)', () => {
  it('releases the tree, continues the run, and records the failure', async () => {
    const disposeA = vi.fn();
    const disposeB = vi.fn();
    const tuples: FileASTTuple[] = [tuple('a.ts', disposeA), tuple('b.ts', disposeB)];

    const config: PipelineConfig = { projectRoot: '/tmp' };
    const result = await runStage2(stream(tuples), [makeVisitor('a.ts')], config, 2);

    // 1. Tree released on every exit path — including the throwing file.
    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(disposeB).toHaveBeenCalledTimes(1);

    // 2. The run continued past the throwing file — b.ts was still visited.
    expect(result.fileCount).toBe(2);
    const visitor = result.visitorResults.get('throwing')!;
    expect(visitor.status.status).toBe('visitor-ran');
    expect(visitor.status.filesProcessed).toBe(1);

    // 3. The failure was recorded, not swallowed (Spec 32 item 1).
    expect(visitor.errors).toEqual([{ file: 'a.ts', error: 'injected visitor fault' }]);
  });

  it('releases the tree when a NON-visitor error propagates (progress callback throws)', async () => {
    // A progress-callback throw is NOT caught by the inner visitor catch — it
    // propagates out of the outer try. The finally must still dispose the tree
    // before rethrowing, so the WASM arena is not pinned by a leaked tree.
    const dispose = vi.fn();
    const tuples: FileASTTuple[] = [tuple('a.ts', dispose)];

    const config: PipelineConfig = {
      projectRoot: '/tmp',
      progressCallback: () => {
        throw new Error('injected progress fault');
      },
    };

    // If dispose does NOT run on this path, the leak is the failure mode — assert
    // dispose fired before the promise rejects.
    let disposedOnThrowPath = false;
    await runStage2(stream(tuples), [makeVisitor(null)], config, 1).catch(() => {
      disposedOnThrowPath = dispose.mock.calls.length === 1;
    });
    expect(disposedOnThrowPath).toBe(true);
  });
});

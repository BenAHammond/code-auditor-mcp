/**
 * Spec 32 — WASM abort recovery fault-injection.
 *
 * The recovery path (detectAbort → recoverParsers → retry-once) is code that
 * only runs when the shared WASM runtime aborts. It cannot be triggered
 * naturally in a green run, so we fault-inject the abort trigger and assert
 * the orchestration: recover exactly once, retry exactly once, a second abort
 * propagates.
 *
 * `recoverParsers()` itself calls `import.meta.resolve('web-tree-sitter')`,
 * which vitest's SSR transform rewrites into `__vite_ssr_import_meta__.resolve`
 * (not a function). The *real* recovery — cache-busted dynamic import of a
 * fresh web-tree-sitter module + grammar reload — is therefore exercised by the
 * standalone node script `scripts/verify-abort-recovery.mjs` against the built
 * dist (real ESM, real `import.meta.resolve`). Here we inject a stub `recover`
 * via the parseWithRecovery seam and verify the retry contract around it.
 *
 * A parse *error* (syntax error) is deliberately NOT an abort: it must
 * propagate without triggering recovery, or every malformed file would pay a
 * full runtime re-instantiation.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { initParsers, getParser, parseWithRecovery } from './parser.js';

function abortError(): Error & { name: string } {
  const err = new Error('Aborted(native code called abort())') as Error & { name: string };
  err.name = 'RuntimeError';
  return err;
}

describe('parseWithRecovery — WASM abort recovery', () => {
  beforeAll(async () => {
    await initParsers();
  });

  it('recovers once and retries the file once on an abort', async () => {
    const parser = getParser('go', false);
    const originalParse = parser.parse.bind(parser);
    let calls = 0;
    // Fault-inject: first parse throws the Emscripten abort signature.
    parser.parse = ((content: string) => {
      calls++;
      if (calls === 1) throw abortError();
      return originalParse(content);
    }) as typeof parser.parse;

    const recover = vi.fn(async () => {});
    const tree = await parseWithRecovery('go', false, 'package main\n\nfunc main() {}\n', recover);

    expect(tree).not.toBeNull();
    expect(recover).toHaveBeenCalledTimes(1); // recovered exactly once
    expect(calls).toBe(2); // first attempt aborted, retry parsed the file
    parser.parse = originalParse;
  });

  it('propagates a second abort — no infinite retry loop', async () => {
    const parser = getParser('go', false);
    const originalParse = parser.parse.bind(parser);
    let calls = 0;
    parser.parse = ((content: string) => {
      calls++;
      throw abortError();
    }) as typeof parser.parse;

    const recover = vi.fn(async () => {});
    await expect(parseWithRecovery('go', false, 'package main', recover)).rejects.toThrow(
      'Aborted(',
    );
    expect(recover).toHaveBeenCalledTimes(1); // one recovery attempt, then give up
    expect(calls).toBe(2); // initial attempt + single retry
    parser.parse = originalParse;
  });

  it('does not recover on a non-abort error — rethrows instead', async () => {
    const parser = getParser('go', false);
    const originalParse = parser.parse.bind(parser);
    let calls = 0;
    parser.parse = ((content: string) => {
      calls++;
      throw new Error('syntax error');
    }) as typeof parser.parse;

    const recover = vi.fn(async () => {});
    await expect(parseWithRecovery('go', false, 'package main', recover)).rejects.toThrow(
      'syntax error',
    );
    expect(calls).toBe(1); // no recovery, no retry
    expect(recover).not.toHaveBeenCalled();
    parser.parse = originalParse;
  });
});

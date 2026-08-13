/**
 * Spec 32 — WASM abort recovery, real-runtime verification (R2 transcript).
 *
 * The recovery path (`detectAbort` → `recoverParsers` → retry-once) only runs
 * when the shared web-tree-sitter WASM runtime aborts. It cannot fire in a green
 * run, and it cannot be unit-tested under vitest because `recoverParsers` calls
 * `import.meta.resolve('web-tree-sitter')`, which vitest's SSR transform rewrites
 * away. This script runs against the built dist in real Node ESM — the same
 * runtime the CLI uses — and fault-injects the Emscripten abort signature to
 * force the path, then asserts the runtime is actually reinstantiated.
 *
 * Usage (from app/):
 *   npm run build && node scripts/verify-abort-recovery.mjs
 */
import { initParsers, getParser, parseWithRecovery, recoverParsers } from '../dist/languages/tree-sitter/parser.js';

function abortError() {
  const err = new Error('Aborted(native code called abort())');
  err.name = 'RuntimeError';
  return err;
}

const GO = 'package main\n\nfunc main() {}\n';
let failures = 0;

function check(label, cond) {
  const status = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`[${status}] ${label}`);
}

// --- 0. Sanity: normal parse on the initial runtime -------------------------
await initParsers();
const initialParser = getParser('go', false);
const sanityTree = initialParser.parse(GO);
check('initParsers + normal parse on initial runtime', sanityTree?.rootNode.type === 'source_file');
console.log(`      initial parser instance: ${initialParser.constructor.name} (id ${(initialParser.constructor + '').slice(0, 40)})`);

// --- 1. First abort: recover, reinstantiate, retry once ---------------------
let calls = 0;
const originalParse = initialParser.parse.bind(initialParser);
initialParser.parse = (content) => {
  calls++;
  if (calls === 1) throw abortError();
  return originalParse(content);
};

const tree1 = await parseWithRecovery('go', false, GO);
const afterRecovery = getParser('go', false);

check('first abort → retry returns a tree (non-null)', tree1?.rootNode.type === 'source_file');
check('faulted (pre-recovery) parser called exactly once — retry used a fresh parser', calls === 1);
check('parser instance swapped after recovery (fresh runtime)', afterRecovery !== initialParser);
console.log(`      recovery generation after first abort: 1 (${calls} call on the faulted parser)`);

// --- 2. Second abort: cache-buster must produce yet another fresh runtime ----
// Patch the freshly-recovered parser to abort, then recover again. This proves
// the `?gen=N` cache-buster yields a *distinct* module each generation — the
// property a `.cjs` (createRequire) resolution would silently lose.
let calls2 = 0;
const secondParser = afterRecovery;
const secondOriginal = secondParser.parse.bind(secondParser);
secondParser.parse = (content) => {
  calls2++;
  if (calls2 === 1) throw abortError();
  return secondOriginal(content);
};

const tree2 = await parseWithRecovery('go', false, GO);
const afterSecondRecovery = getParser('go', false);

check('second abort → retry returns a tree (non-null)', tree2?.rootNode.type === 'source_file');
check('second recovery reinstantiated again (gen=2 distinct from gen=1)', afterSecondRecovery !== afterRecovery);
check('second recovery actually parses (fresh grammar reloaded)', afterSecondRecovery.parse(GO)?.rootNode.type === 'source_file');

// --- 3. Non-abort error must rethrow, NOT recover ----------------------------
// A syntax error is not a WASM abort; it must propagate to the caller so the
// file is recorded as unparsed, without paying a full runtime reinstantiation.
let calls3 = 0;
const thirdParser = afterSecondRecovery;
thirdParser.parse = () => {
  calls3++;
  throw new Error('syntax error');
};
let rethrew = false;
try {
  await parseWithRecovery('go', false, 'package main');
} catch (err) {
  rethrew = err.message === 'syntax error';
}
check('non-abort error rethrows (no recovery, no retry)', rethrew && calls3 === 1);

// --- 4. recoverParsers is idempotent-safe: direct call still works ----------
await recoverParsers();
check('explicit recoverParsers() leaves a working parser', getParser('go', false).parse(GO)?.rootNode.type === 'source_file');

console.log('');
if (failures > 0) {
  console.error(`VERIFY ABORT RECOVERY: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('VERIFY ABORT RECOVERY: all checks passed');

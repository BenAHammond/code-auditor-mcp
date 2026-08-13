/**
 * web-tree-sitter WASM loader
 *
 * Loads WASM grammar files and creates tree-sitter parsers for supported languages.
 * initParsers() must be called once at entry points (CLI boot, MCP server start)
 * before any adapterBridge use. Adapter calls to getParser() on an uninitialized
 * parser throw with a clear message — this is a programmer error, not a runtime
 * condition to recover from.
 *
 * Spec 32 — WASM Abort recovery:
 * `parser.parse()` can throw a `WebAssembly.RuntimeError` with the Emscripten
 * `Aborted()` signature when the shared WASM runtime's arena reaches its ceiling.
 * Once `ABORT` is set, the runtime singleton is dead and every subsequent parse
 * fails. We therefore:
 *   - hold the `Parser`/`Language` classes in mutable bindings (not static imports)
 *     so a fresh runtime can be swapped in,
 *   - expose `parseWithRecovery()` which detects an abort, reinstantiates the module
 *     (cache-busted dynamic import), retries the file once, and otherwise rethrows
 *     so the caller records the file as unparsed (never silently dropped).
 */

import { readFileSync } from 'node:fs';
import * as webTreeSitter from 'web-tree-sitter';
import type { Tree } from 'web-tree-sitter';

// Mutable bindings — a recovery swaps these to a fresh module's classes.
let Parser: typeof webTreeSitter.Parser = webTreeSitter.Parser;
let Language: typeof webTreeSitter.Language = webTreeSitter.Language;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let initialized = false;
const parsers = new Map<string, typeof Parser.prototype>();
const languages = new Map<string, typeof Language.prototype>();

/**
 * Cache-buster for recovering from an Emscripten Abort(). Each recovery bumps
 * this and dynamically re-imports `web-tree-sitter` with `?gen=N` appended so
 * Node's module cache treats it as a distinct module instance with a fresh,
 * non-aborted runtime singleton.
 */
let recoveryGeneration = 0;

/**
 * Mapping from adapter language ID to the grammar WASM filename.
 * Keyed by the strings adapters use internally (not file extensions).
 */
const GRAMMAR_FILES: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  go: 'tree-sitter-go.wasm',
  css: 'tree-sitter-css.wasm',
  scss: 'tree-sitter-scss.wasm',
};

/**
 * Map tree-sitter language names to the grammar WASM key.
 * tree-sitter-typescript has two WASM files: one for TS, one for TSX.
 */
const LANGUAGE_GRAMMAR_MAP: Record<string, string> = {
  typescript: 'typescript',
  javascript: 'javascript',
  go: 'go',
  css: 'css',
  scss: 'scss',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize tree-sitter parsers for all supported languages.
 * MUST be called once before any adapterBridge or adapter use.
 *
 * WASM paths are resolved relative to this module's location via import.meta.url,
 * NOT process.cwd(). This ensures the grammars are found regardless of the
 * working directory at runtime (critical for npx-invoked hooks).
 */
export async function initParsers(): Promise<void> {
  if (initialized) return;
  await loadGrammarsAndParsers();
  initialized = true;
}

/**
 * Shared grammar + parser construction, used by both initial startup and
 * post-abort recovery. Clears the singleton maps and rebuilds them from the
 * current (possibly freshly-imported) Parser/Language classes.
 */
async function loadGrammarsAndParsers(): Promise<void> {
  // Initialize the tree-sitter runtime (loads the tree-sitter C library WASM)
  await Parser.init();

  // Resolve the grammars directory relative to this module
  // At runtime: dist/languages/tree-sitter/parser.js → ../../grammars/
  const grammarsDir = new URL('../../grammars/', import.meta.url);

  languages.clear();
  for (const [grammarKey, wasmFile] of Object.entries(GRAMMAR_FILES)) {
    const wasmUrl = new URL(wasmFile, grammarsDir);
    const wasmBuffer = readFileSync(wasmUrl);
    const language = await Language.load(wasmBuffer);
    languages.set(grammarKey, language);
  }

  parsers.clear();
  // Create parser instances for each primary language
  for (const [lang, grammarKey] of Object.entries(LANGUAGE_GRAMMAR_MAP)) {
    const language = languages.get(grammarKey);
    if (!language) {
      throw new Error(
        `Grammar "${grammarKey}" not found for language "${lang}". ` +
        `Available grammars: ${[...languages.keys()].join(', ')}`
      );
    }
    const parser = new Parser();
    parser.setLanguage(language);
    parsers.set(lang, parser);
  }
}

/**
 * Detect an Emscripten Abort() surfaced as a thrown WebAssembly.RuntimeError.
 * These errors are the signature of a dead WASM runtime — not a per-file parse
 * failure — and must trigger module recovery rather than a per-file skip.
 */
function detectAbort(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = (err as { name?: string }).name ?? '';
  const message = err.message ?? '';
  return (
    name === 'RuntimeError' ||
    message.includes('Aborted(') ||
    message.includes('abort(')
  );
}

/**
 * Reinstantiate the tree-sitter runtime after an abort. Dynamically re-imports
 * a fresh `web-tree-sitter` module instance (cache-busted) so the dead shared
 * WASM singleton is replaced, then rebuilds all grammars and parsers from it.
 */
export async function recoverParsers(): Promise<void> {
  recoveryGeneration++;
  const baseUrl = import.meta.resolve('web-tree-sitter');
  const fresh = await import(`${baseUrl}?gen=${recoveryGeneration}`);
  Parser = fresh.Parser;
  Language = fresh.Language;
  await loadGrammarsAndParsers();
}

/**
 * Parse content with abort recovery. On an abort, reinstantiates the runtime
 * and retries the file once. A second abort propagates to the caller so the
 * file is recorded as unparsed rather than silently dropped.
 *
 * @param lang - Language identifier ('typescript', 'javascript', 'go', ...)
 * @param isTsx - If true, use the TSX grammar
 * @param content - Source text to parse
 * @param recover - Fault-injection seam. Defaults to the real `recoverParsers`;
 *   tests may pass a stub to exercise the retry orchestration without hitting
 *   `import.meta.resolve` (which vitest's SSR transform rewrites away).
 * @returns the parsed tree, or null if the parser produced no tree.
 */
export async function parseWithRecovery(
  lang: string,
  isTsx: boolean,
  content: string,
  recover: () => Promise<void> = recoverParsers,
): Promise<Tree | null> {
  try {
    const parser = getParser(lang, isTsx);
    return parser.parse(content);
  } catch (err) {
    if (!detectAbort(err)) throw err;
    // Abort killed the shared runtime — reinstantiate and retry the file once.
    await recover();
    const parser = getParser(lang, isTsx);
    return parser.parse(content); // a second abort propagates to the caller
  }
}

/**
 * Get a tree-sitter Parser for the given language.
 * Throws if initParsers() has not been called.
 *
 * @param lang - Language identifier ('typescript', 'javascript', 'go')
 * @param isTsx - If true and lang is 'typescript', use the TSX grammar
 */
export function getParser(lang: string, isTsx: boolean = false): typeof Parser.prototype {
  if (!initialized) {
    throw new Error(
      'Tree-sitter parsers not initialized. Call initParsers() before using any adapter.'
    );
  }

  const key = isTsx ? 'tsx' : lang;
  // tsx is handled separately — it shares the TypeScript adapter
  if (isTsx && languages.has('tsx')) {
    // Return a one-off parser with TSX grammar
    const tsxLang = languages.get('tsx')!;
    const p = new Parser();
    p.setLanguage(tsxLang);
    return p;
  }

  const parser = parsers.get(lang);
  if (!parser) {
    throw new Error(
      `No tree-sitter parser for language "${lang}". ` +
      `Supported: ${[...parsers.keys()].join(', ')}`
    );
  }
  return parser;
}

/**
 * Returns true if parsers have been initialized.
 */
export function isInitialized(): boolean {
  return initialized;
}

/**
 * Get available language identifiers.
 */
export function getAvailableLanguages(): string[] {
  return [...parsers.keys()];
}

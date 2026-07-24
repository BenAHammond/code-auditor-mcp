/**
 * web-tree-sitter WASM loader
 *
 * Loads WASM grammar files and creates tree-sitter parsers for supported languages.
 * initParsers() must be called once at entry points (CLI boot, MCP server start)
 * before any adapterBridge use. Adapter calls to getParser() on an uninitialized
 * parser throw with a clear message — this is a programmer error, not a runtime
 * condition to recover from.
 */

import { readFileSync } from 'node:fs';
import { Parser, Language } from 'web-tree-sitter';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let initialized = false;
const parsers = new Map<string, Parser>();
const languages = new Map<string, Language>();

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

  // Initialize the tree-sitter runtime (loads the tree-sitter C library WASM)
  await Parser.init();

  // Resolve the grammars directory relative to this module
  // At runtime: dist/languages/tree-sitter/parser.js → ../../grammars/
  const grammarsDir = new URL('../../grammars/', import.meta.url);

  for (const [grammarKey, wasmFile] of Object.entries(GRAMMAR_FILES)) {
    const wasmUrl = new URL(wasmFile, grammarsDir);
    const wasmBuffer = readFileSync(wasmUrl);
    const language = await Language.load(wasmBuffer);
    languages.set(grammarKey, language);
  }

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

  initialized = true;
}

/**
 * Get a tree-sitter Parser for the given language.
 * Throws if initParsers() has not been called.
 *
 * @param lang - Language identifier ('typescript', 'javascript', 'go')
 * @param isTsx - If true and lang is 'typescript', use the TSX grammar
 */
export function getParser(lang: string, isTsx: boolean = false): Parser {
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

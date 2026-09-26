/**
 * Multi-language support exports
 */

export * from './types.js';
export * from './LanguageRegistry.js';
export * from './UniversalAnalyzer.js';
export * from './typescript/TreeSitterTypeScriptAdapter.js';
export * from './go/GoAdapter.js';
export * from './tree-sitter/TreeSitterCssAdapter.js';
export * from './json/JsonAdapter.js';

// Parser initialization for entry points
export { initParsers, isInitialized } from './tree-sitter/parser.js';

import { LanguageRegistry } from './LanguageRegistry.js';
import { TreeSitterTypeScriptAdapter } from './typescript/TreeSitterTypeScriptAdapter.js';
import { TreeSitterGoAdapter } from './go/GoAdapter.js';
import { TreeSitterCssAdapter } from './tree-sitter/TreeSitterCssAdapter.js';
import { JsonAdapter } from './json/JsonAdapter.js';

/**
 * Initialize the language system with default adapters.
 * Synchronous — registers adapters only. Entry points MUST also call
 * initParsers() before any adapter.parse() calls.
 */
export function initializeLanguages(): void {
  const registry = LanguageRegistry.getInstance();

  // Register tree-sitter based language adapters
  registry.registerAdapter(new TreeSitterTypeScriptAdapter());
  registry.registerAdapter(new TreeSitterGoAdapter());
  registry.registerAdapter(new TreeSitterCssAdapter());
  // JSON is a format (Spec 68 Amendment 1): a position-preserving parser, not
  // tree-sitter — no JSON WASM grammar ships in this repository.
  registry.registerAdapter(new JsonAdapter());
}

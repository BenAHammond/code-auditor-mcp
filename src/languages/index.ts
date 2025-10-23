/**
 * Multi-language support exports
 */

export * from './types.js';
export * from './LanguageRegistry.js';
export * from './UniversalAnalyzer.js';
export * from './typescript/TypeScriptAdapter.js';
export * from './go/GoAdapter.js';

import { LanguageRegistry } from './LanguageRegistry.js';
import { TypeScriptAdapter } from './typescript/TypeScriptAdapter.js';
import { GoAdapter } from './go/GoAdapter.js';

/**
 * Initialize the language system with default adapters
 */
export function initializeLanguages(): void {
  const registry = LanguageRegistry.getInstance();
  
  // Register language adapters
  registry.registerAdapter(new TypeScriptAdapter());
  registry.registerAdapter(new GoAdapter());
  
  // Future: Add more language adapters here
  // registry.registerAdapter(new PythonAdapter());
}
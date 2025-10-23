/**
 * Registry for managing language adapters
 */

import type { LanguageAdapter } from './types.js';
import path from 'path';

export class LanguageRegistry {
  private static instance: LanguageRegistry;
  private adapters = new Map<string, LanguageAdapter>();
  private extensionMap = new Map<string, LanguageAdapter>();
  
  private constructor() {}
  
  /**
   * Get singleton instance
   */
  static getInstance(): LanguageRegistry {
    if (!LanguageRegistry.instance) {
      LanguageRegistry.instance = new LanguageRegistry();
    }
    return LanguageRegistry.instance;
  }
  
  /**
   * Register a language adapter
   */
  registerAdapter(adapter: LanguageAdapter): void {
    this.adapters.set(adapter.name, adapter);
    
    // Map file extensions to adapter
    for (const ext of adapter.fileExtensions) {
      this.extensionMap.set(ext.toLowerCase(), adapter);
    }
  }
  
  /**
   * Unregister a language adapter
   */
  unregisterAdapter(name: string): void {
    const adapter = this.adapters.get(name);
    if (adapter) {
      // Remove extension mappings
      for (const ext of adapter.fileExtensions) {
        this.extensionMap.delete(ext.toLowerCase());
      }
      this.adapters.delete(name);
    }
  }
  
  /**
   * Get adapter by name
   */
  getAdapter(name: string): LanguageAdapter | null {
    return this.adapters.get(name) || null;
  }
  
  /**
   * Get adapter for a file based on its extension
   */
  getAdapterForFile(filePath: string): LanguageAdapter | null {
    const ext = path.extname(filePath).toLowerCase();
    const adapter = this.extensionMap.get(ext);
    
    // Double-check with adapter's supportsFile method
    if (adapter && adapter.supportsFile(filePath)) {
      return adapter;
    }
    
    // Fallback: try all adapters
    for (const adapter of this.adapters.values()) {
      if (adapter.supportsFile(filePath)) {
        return adapter;
      }
    }
    
    return null;
  }
  
  /**
   * Get all registered adapters
   */
  getAllAdapters(): LanguageAdapter[] {
    return Array.from(this.adapters.values());
  }
  
  /**
   * Get all supported file extensions
   */
  getSupportedExtensions(): string[] {
    return Array.from(this.extensionMap.keys());
  }
  
  /**
   * Clear all registered adapters
   */
  clear(): void {
    this.adapters.clear();
    this.extensionMap.clear();
  }
}
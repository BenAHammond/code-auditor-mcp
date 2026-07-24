/**
 * ORM Adapter Registry — Spec 15 R2
 *
 * Singleton registry for ORM adapters. Follows the same pattern as
 * LanguageRegistry: adapters register by name + file extensions, and
 * the registry resolves the correct adapter for a given file.
 */

import type { OrmAdapter } from './types.js';
import path from 'path';

export class OrmAdapterRegistry {
  private static instance: OrmAdapterRegistry;
  private adapters = new Map<string, OrmAdapter>();
  private extensionMap = new Map<string, OrmAdapter>();

  private constructor() {}

  static getInstance(): OrmAdapterRegistry {
    if (!OrmAdapterRegistry.instance) {
      OrmAdapterRegistry.instance = new OrmAdapterRegistry();
    }
    return OrmAdapterRegistry.instance;
  }

  /**
   * Register an ORM adapter.
   */
  registerAdapter(adapter: OrmAdapter): void {
    this.adapters.set(adapter.name, adapter);
    for (const ext of adapter.fileExtensions) {
      this.extensionMap.set(ext.toLowerCase(), adapter);
    }
  }

  /**
   * Get adapter by name.
   */
  getAdapter(name: string): OrmAdapter | null {
    return this.adapters.get(name) || null;
  }

  /**
   * Get adapter for a file based on its extension.
   * Falls back to content-based detection via supportsFile.
   */
  getAdapterForFile(filePath: string): OrmAdapter | null {
    const ext = path.extname(filePath).toLowerCase();
    const adapter = this.extensionMap.get(ext);

    if (adapter && adapter.supportsFile(filePath)) {
      return adapter;
    }

    // Fallback: try content-based detection for all adapters
    for (const a of this.adapters.values()) {
      if (a.supportsFile(filePath)) {
        return a;
      }
    }

    return null;
  }

  /**
   * Get all registered adapters.
   */
  getAllAdapters(): OrmAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Check if any registered adapter handles this file.
   */
  hasAdapterForFile(filePath: string): boolean {
    return this.getAdapterForFile(filePath) !== null;
  }

  /**
   * Clear all registered adapters (useful in tests).
   */
  clear(): void {
    this.adapters.clear();
    this.extensionMap.clear();
  }
}

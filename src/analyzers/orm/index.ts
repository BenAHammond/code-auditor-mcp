/**
 * ORM Adapter Module — Spec 15 R2
 *
 * Public API for ORM-aware schema extraction.
 */

export { OrmAdapterRegistry } from './adapterRegistry.js';
export type { OrmAdapter, OrmTableReference, OrmSchemaDefinition } from './types.js';
export { DrizzleAdapter } from './drizzleAdapter.js';
export { PrismaAdapter } from './prismaAdapter.js';

import { OrmAdapterRegistry } from './adapterRegistry.js';
import { DrizzleAdapter } from './drizzleAdapter.js';
import { PrismaAdapter } from './prismaAdapter.js';

let initialized = false;

/**
 * Register built-in ORM adapters. Idempotent — safe to call multiple times.
 */
export function initializeOrmAdapters(): void {
  if (initialized) return;
  const registry = OrmAdapterRegistry.getInstance();
  registry.registerAdapter(new DrizzleAdapter());
  registry.registerAdapter(new PrismaAdapter());
  initialized = true;
}

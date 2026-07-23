/**
 * Spec-21 R6: Cross-file provenance — provider exports DB-provenanced 'db'.
 *
 * The exported 'db' carries provenance from the drizzle-orm import.
 * Consumer files importing 'db' from here inherit that provenance.
 */

import { drizzle } from 'drizzle-orm';

const dbBinding = { exec: (_sql: string) => [] } as any;

// db is DB-provenanced via drizzle import propagation.
export const db = drizzle(dbBinding);

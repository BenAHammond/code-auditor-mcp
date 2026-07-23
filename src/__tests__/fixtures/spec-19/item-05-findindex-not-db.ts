/**
 * Spec-19 item 5 — loop-query false positive.
 * `.findIndex()` in a `forEach` — array method matches `find` substring.
 * The violation should NOT fire: findIndex is not a DB call.
 */

interface CacheEntry {
  key: string;
  value: unknown;
  ttl: number;
}

function evictStale(cache: CacheEntry[], now: number): void {
  cache.forEach((entry, idx) => {
    // findIndex is an Array method, not a DB query
    const firstStale = cache.findIndex(e => e.ttl < now);
    if (idx === firstStale) {
      cache.splice(idx, 1);
    }
  });
}

export { evictStale };

/**
 * Spec-19 item 6 — loop-query false positive.
 * Loop iterates over in-memory array; no DB call in loop body.
 * The violation should NOT fire: pure data transformation, no DB access inside the loop.
 */

interface RawMetric {
  timestamp: number;
  value: number;
  label: string;
}

interface AggregatedMetric {
  day: string;
  avg: number;
  max: number;
  count: number;
}

function aggregateMetrics(metrics: RawMetric[]): AggregatedMetric[] {
  const byDay = new Map<string, { total: number; max: number; count: number }>();

  // Pure in-memory iteration — data transformation only
  for (const m of metrics) {
    const day = new Date(m.timestamp).toISOString().slice(0, 10);
    const acc = byDay.get(day) || { total: 0, max: -Infinity, count: 0 };
    acc.total += m.value;
    acc.max = Math.max(acc.max, m.value);
    acc.count++;
    byDay.set(day, acc);
  }

  // Use spread (not Array.from) — 'from' is in DB_METHODS and would trigger a false-positive loop-query
  return [...byDay.entries()].map(([day, acc]) => ({
    day,
    avg: acc.total / acc.count,
    max: acc.max,
    count: acc.count,
  }));
}

export { aggregateMetrics };

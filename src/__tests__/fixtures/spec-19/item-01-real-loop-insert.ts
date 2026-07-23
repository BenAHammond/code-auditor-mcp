/**
 * Spec-19 item 1 — loop-query TRUE positive (oracle: MUST fire).
 * INSERT in a loop calling 3rd-party enrichment API then writing results.
 * Real N+1: per-iteration DB write in a loop.
 */
import { query } from './db';

interface EnrichedRecord {
  id: string;
  summary: string;
  score: number;
}

async function enrichAndStore(items: Array<{ id: string; text: string }>): Promise<EnrichedRecord[]> {
  const results: EnrichedRecord[] = [];

  for (const item of items) {
    const enriched = await callEnrichmentAPI(item.text);

    // Per-iteration INSERT — real loop-query (N+1)
    await query(
      `INSERT INTO reports (item_id, summary, score) VALUES ('${item.id}', '${enriched.summary}', ${enriched.score})`
    );

    results.push({ id: item.id, summary: enriched.summary, score: enriched.score });
  }

  return results;
}

async function callEnrichmentAPI(text: string): Promise<{ summary: string; score: number }> {
  return { summary: `summary: ${text}`, score: 0.85 };
}

export { enrichAndStore };

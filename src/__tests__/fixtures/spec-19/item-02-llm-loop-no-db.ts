/**
 * Spec-19 item 2 — loop-query false positive.
 * Loop body calls an LLM function; the INSERT is a batch call OUTSIDE the loop.
 * The violation should NOT fire: no DB call exists inside the loop body.
 */
import { query } from './db';

async function enrichAndInsert(items: string[]) {
  const enriched: Array<{ id: string; data: string }> = [];

  // Loop body: calls LLM, assembles data, no DB call
  for (const item of items) {
    const result = await callLLM(`summarize: ${item}`);
    enriched.push({ id: item, data: result.summary });
  }

  // INSERT is a batch call outside the loop — not loop-query
  await query('INSERT INTO reports (id, summary) VALUES ' + enriched.map(e => `('${e.id}', '${e.data}')`).join(','));
}

async function callLLM(prompt: string): Promise<{ summary: string }> {
  // Stub — in reality calls OpenAI/Anthropic
  return { summary: `summary of: ${prompt}` };
}

export { enrichAndInsert };

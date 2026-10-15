/**
 * Directive H item 2 — the candidate-emission artifact writer.
 *
 * The migrated rules select candidate sites through `ctx.emitCandidate` and
 * the runner carries them out on `result.metadata.candidates`. This module
 * serializes them to the diagnostic artifact that the services/ audit route
 * consumes: per rule, its disposition vocabulary (keys + descriptions read
 * straight from the rule's `dispositions`, never a literal list here) and its
 * candidate sites, each enriched with the source line text at the site's span.
 *
 * The source line is read here — from the CLI's local filesystem — because the
 * consumer (the services/ Worker) is remote and cannot read the audited tree.
 * Nothing in this module (or anywhere under `app/`) reaches a model: it only
 * writes the deterministic pre-classification record.
 */

import { promises as fs } from 'fs';
import { MIGRATED_RULES } from './rules/registry.js';
import type { AuditResult } from '../types.js';
import type { Disposition } from './types.js';

export interface CandidatesArtifactSite {
  file: string;
  span: { line: number; column?: number };
  disposition: string;
  /** The source line text at `span.line`, read from the audited file so the
   *  remote audit route has the site's source without filesystem access. */
  source: string;
}

export interface CandidatesArtifactRule {
  ruleId: string;
  /** The rule's disposition vocabulary, copied from the rule's own
   *  `dispositions` — the audit builds its choice `criteria` keys from these. */
  dispositions: Array<{ key: string; description: string }>;
  sites: CandidatesArtifactSite[];
}

export interface CandidatesArtifact {
  schemaVersion: 1;
  generatedAt: string;
  rules: CandidatesArtifactRule[];
}

async function readSourceLine(file: string, line: number): Promise<string> {
  if (!Number.isInteger(line) || line < 1) return '';
  try {
    const content = await fs.readFile(file, 'utf8');
    return content.split('\n')[line - 1] ?? '';
  } catch {
    return '';
  }
}

/**
 * Build the candidates artifact from an audit result. Rules that declared
 * `dispositions` but emitted no candidate sites are omitted (the artifact only
 * carries sites the audit will sample). Candidate sites are grouped by rule id;
 * ordering follows first-emission order.
 *
 * @param result - The completed audit result carrying `metadata.candidates`.
 * @returns The serializable candidates artifact (schema version 1).
 */
export async function buildCandidatesArtifact(
  result: AuditResult,
): Promise<CandidatesArtifact> {
  const candidates = result.metadata.candidates ?? [];

  const dispositionsByRule = new Map<string, readonly Disposition[]>();
  for (const rule of MIGRATED_RULES) {
    if (rule.dispositions) dispositionsByRule.set(rule.id, rule.dispositions);
  }

  type Candidate = NonNullable<AuditResult['metadata']['candidates']>[number];
  const sitesByRule = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = sitesByRule.get(c.ruleId) ?? [];
    list.push(c);
    sitesByRule.set(c.ruleId, list);
  }

  const rules: CandidatesArtifactRule[] = [];
  for (const [ruleId, sites] of sitesByRule) {
    const dispositions = dispositionsByRule.get(ruleId) ?? [];
    rules.push({
      ruleId,
      dispositions: dispositions.map((d) => ({ key: d.key, description: d.description })),
      sites: await Promise.all(sites.map(async (s) => ({
        file: s.file,
        span: s.span,
        disposition: s.disposition,
        source: await readSourceLine(s.file, s.span.line),
      }))),
    });
  }

  return { schemaVersion: 1, generatedAt: new Date().toISOString(), rules };
}

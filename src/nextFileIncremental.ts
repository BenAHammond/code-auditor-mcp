/**
 * Incremental `next-file` — snapshot + content-hash diff + per-analyzer merge.
 *
 * The refactoring loop (`code-audit next-file`) must not pay a full cold audit
 * on every call, or an agent calls it once and stops. This module seeds a full
 * audit once, persists a snapshot of (file → content hash + mtime + findings),
 * then on each warm call hashes the current file set, re-audits only what
 * changed, and merges per-analyzer.
 *
 * ## Per-analyzer cacheability (the crux of incremental correctness)
 *
 * Findings fall into three buckets, decided per analyzer rather than globally —
 * a uniform "cache everything" or "recompute everything" is wrong for one of
 * the three, and that is the part that silently corrupts a cached queue.
 *
 * | Bucket | Analyzers | On a warm call | Why it is safe |
 * |--------|-----------|----------------|----------------|
 * | **File-local** (cache per file) | solid, data-access, documentation, react, dry, schema-sql, schema-code, schema-prisma, schema-json, invariants | re-audit only changed/added files; unchanged files keep their cache | a finding on file F is a pure function of F's AST + the (session-stable) rules. `dry` cross-file findings are re-emitted from whichever file is (re)visited, so a still-broken file comes back. |
 * | **Corpus (DB-backed)** (recompute every call) | styles, conventions, cross-domain | recompute from the scoped audit's reducer output | these reducers read the persistent SQLite index (full corpus), not the scoped file list, so their scoped-run output is already full-corpus. |
 * | **Corpus (fact-based) — schema** (cache + escalate) | schema | reuse cached findings UNLESS a schema-definition file changed, in which case force a full re-seed | the known-tables catalog is built in-memory from the current run's visitor facts. A scoped run sees only scoped facts, so an unchanged migration's tables would vanish and query files would be falsely flagged `unknown-table`. The catalog can only change when a schema-definition file changes — detect that and re-seed; otherwise the cache is correct. |
 *
 * The two file-local caveats, documented rather than hidden:
 * - `invariants` is a Stage-3 reducer that runs per-file. Its `module-boundary`
 *   import resolution uses the *scope's* known-files set, so a warm re-audit of
 *   a changed file that imports an unchanged file can under-resolve a boundary.
 *   This is the same limitation the diff-scoped `changed` hook already has; the
 *   cold seed (full known-files) is the authoritative baseline.
 * - `schema` (fact-based) is the only analyzer that must NOT be recomputed from
 *   a scoped run; see the escalation rule above.
 *
 * ## Staleness is structural, not periodic
 *
 * The snapshot records a content hash AND mtime per file it covers. On every
 * call the current file set is hashed; if a file's content changed but its
 * mtime did not, the (mtime-based) diff missed a change and that is a hard
 * error — never a quiet re-seed. Same shape as the file-accounting balance
 * assertion.
 */

import { readFileSync, statSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { relative, resolve, join, isAbsolute } from 'path';

import { createAuditRunner } from './auditRunner.js';
import { CodeIndexDB } from './codeIndexDB.js';
import { findConfigFileUp, loadConfig } from './config/configLoader.js';
import { discoverFilesDetailed } from './utils/fileDiscovery.js';
import type { Violation } from './types.js';

const SNAPSHOT_KEY = 'next-file:snapshot';

/** Extensions that carry table/DDL definitions — a deleted one can shift the catalog. */
const SCHEMA_DEFINITION_EXTENSIONS = new Set(['.sql', '.prisma']);

/**
 * File-local analyzers: a finding on F is a pure function of F's AST (+ rules).
 * Cacheable per file. `dry` is a stage-2 visitor; its within-file findings are
 * file-local and its cross-file findings are re-emitted from whatever file is
 * (re)visited, so caching per file preserves the "a still-broken file comes
 * back" guarantee. `invariants` runs per-file (see module doc caveat).
 */
const FILE_LOCAL = new Set([
  'solid',
  'data-access',
  'documentation',
  'react',
  'dry',
  'schema-sql',
  'schema-code',
  'schema-prisma',
  'schema-json',
  'invariants',
]);

/**
 * Corpus (DB-backed) analyzers: findings depend on the whole corpus but are
 * re-derived from the persistent index on every scoped run, so recomputing them
 * each warm call is correct. Anything not listed and not `schema`/FILE_LOCAL is
 * also treated as DB-backed (safe default: never cache what you can't prove is
 * file-local).
 */
const CORPUS_DB = new Set(['styles', 'conventions', 'cross-domain']);

/**
 * Full-corpus-only reducers: they short-circuit with `notRunReason` on a scoped
 * run (see the `context.isScoped` guards in `pipelineAdapters.ts`), so a warm
 * re-audit produces *no* findings for them — not "empty", but "not run". Replacing
 * the cached findings with the scoped run's empty output would silently drop every
 * `dependency-graph` / `api-contract` / `schema-validator` finding on each warm
 * call. Their cached findings are therefore preserved on a merge (best-effort:
 * they reflect the last full audit; a full re-seed refreshes them).
 */
const FULL_CORPUS_ONLY = new Set(['dependency-graph', 'api-contract', 'schema-validator']);

/** Per-file record in the snapshot: content hash + mtime for the staleness gate. */
export interface FileRecord {
  hash: string;
  mtimeMs: number;
}

export interface NextFileSnapshot {
  version: 1;
  projectRoot: string;
  files: Record<string, FileRecord>;
  visitorFindings: Record<string, Violation[]>;
  corpusFindings: Violation[];
  schemaFindings: Violation[];
}

export interface FileDiff {
  changed: string[];
  added: string[];
  deleted: string[];
}

export type StalenessReason = 'mtime-preserved-content-change' | 'missing-on-disk';

export interface StalenessViolation {
  file: string;
  reason: StalenessReason;
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Hash + stat every file, keyed by project-relative path. */
export function hashAndStatFiles(
  files: string[],
  projectRoot: string,
): Record<string, FileRecord> {
  const out: Record<string, FileRecord> = {};
  for (const file of files) {
    const abs = isAbsolute(file) ? file : join(projectRoot, file);
    try {
      out[relative(projectRoot, abs)] = {
        hash: sha256(readFileSync(abs)),
        mtimeMs: statSync(abs).mtimeMs,
      };
    } catch {
      // Unreadable (deleted between discovery and hash) — excluded from the set.
    }
  }
  return out;
}

/** Diff the current file set against the snapshot's recorded set. */
export function diffFiles(
  snapshotFiles: Record<string, FileRecord>,
  current: Record<string, FileRecord>,
): FileDiff {
  const changed: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];

  for (const [rel, rec] of Object.entries(current)) {
    const prev = snapshotFiles[rel];
    if (!prev) added.push(rel);
    else if (prev.hash !== rec.hash) changed.push(rel);
  }
  for (const rel of Object.keys(snapshotFiles)) {
    if (!(rel in current)) deleted.push(rel);
  }

  // Sort for deterministic output.
  changed.sort();
  added.sort();
  deleted.sort();
  return { changed, added, deleted };
}

/**
 * Structural staleness check. Returns violations that must hard-error rather
 * than quietly proceeding with stale cache:
 *
 *  - `mtime-preserved-content-change`: a file's content hash changed but its
 *    mtime did not — an mtime-based diff would have missed this change.
 *  - `missing-on-disk`: a file left the current set but still exists on disk —
 *    discovery missed it, and dropping its findings would be silent data loss.
 */
export function assertNoStaleFiles(
  snapshotFiles: Record<string, FileRecord>,
  current: Record<string, FileRecord>,
  projectRoot: string,
): StalenessViolation[] {
  const out: StalenessViolation[] = [];
  for (const [rel, prev] of Object.entries(snapshotFiles)) {
    const cur = current[rel];
    if (!cur) {
      if (existsSync(join(projectRoot, rel))) {
        out.push({ file: rel, reason: 'missing-on-disk' });
      }
      continue;
    }
    if (prev.hash !== cur.hash && prev.mtimeMs === cur.mtimeMs) {
      out.push({ file: rel, reason: 'mtime-preserved-content-change' });
    }
  }
  return out;
}

/** A structural view of one analyzer result (violations only). */
export interface AnalyzerResultLike {
  violations: Violation[];
}

export interface SplitResult {
  visitorFindings: Record<string, Violation[]>;
  corpusFindings: Violation[];
  schemaFindings: Violation[];
}

/** Split an audit result into file-local / corpus-DB / schema-fact buckets. */
export function splitFindings(
  analyzerResults: Record<string, AnalyzerResultLike>,
  projectRoot: string,
): SplitResult {
  const visitorFindings: Record<string, Violation[]> = {};
  const corpusFindings: Violation[] = [];
  const schemaFindings: Violation[] = [];

  for (const [name, ar] of Object.entries(analyzerResults)) {
    const vs = ar.violations || [];
    if (FILE_LOCAL.has(name)) {
      for (const v of vs) {
        const rel = relative(projectRoot, v.file || '');
        (visitorFindings[rel] = visitorFindings[rel] || []).push(v);
      }
    } else if (name === 'schema') {
      schemaFindings.push(...vs);
    } else {
      // CORPUS_DB or unknown — recompute each warm call (safe: DB-backed).
      corpusFindings.push(...vs);
    }
  }

  return { visitorFindings, corpusFindings, schemaFindings };
}

export interface MergeInput {
  cachedVisitor: Record<string, Violation[]>;
  freshVisitor: Record<string, Violation[]>;
  /** Cached corpus findings from the previous snapshot (needed to preserve
   *  full-corpus-only analyzers that a scoped run cannot recompute). */
  cachedCorpus: Violation[];
  freshCorpus: Violation[];
  freshSchema: Violation[];
  changed: string[];
  added: string[];
  deleted: string[];
}

export interface MergeOutput {
  visitorFindings: Record<string, Violation[]>;
  corpusFindings: Violation[];
  schemaFindings: Violation[];
  all: Violation[];
}

/**
 * Merge cached per-file findings with fresh scoped results. Unchanged files
 * keep their cache; changed/added files are overwritten (including to empty —
 * a fixed file must not fall back to its stale cache); deleted files drop.
 * Corpus-DB findings are replaced wholesale (they are full-corpus and the scoped
 * run recomputes them from the persistent index); full-corpus-only findings
 * (dependency-graph/api-contract/schema-validator) are preserved from the cache
 * because a scoped run short-circuits them. Schema findings are passed through
 * (the caller decides cache-vs-re-seed).
 */
export function mergeFindings(input: MergeInput): MergeOutput {
  const drop = new Set([...input.deleted, ...input.changed, ...input.added]);

  const visitorFindings: Record<string, Violation[]> = {};
  for (const [rel, vs] of Object.entries(input.cachedVisitor)) {
    if (!drop.has(rel)) visitorFindings[rel] = vs;
  }
  for (const rel of [...input.changed, ...input.added]) {
    visitorFindings[rel] = input.freshVisitor[rel] || [];
  }

  // Recomputable corpus findings come from the scoped run; full-corpus-only
  // analyzers (which the scoped run skipped) keep their cached findings.
  const corpusFindings = [
    ...input.freshCorpus,
    ...input.cachedCorpus.filter((v) => FULL_CORPUS_ONLY.has(v.analyzer ?? '')),
  ];
  const schemaFindings = input.freshSchema;
  const all = [
    ...Object.values(visitorFindings).flat(),
    ...corpusFindings,
    ...schemaFindings,
  ];
  return { visitorFindings, corpusFindings, schemaFindings, all };
}

export interface RunNextFileResult {
  snapshot: NextFileSnapshot;
  violations: Violation[];
  cold: boolean;
  summary: NextFileSummary;
}

export interface NextFileSummary {
  totalViolations: number;
  criticalIssues: number;
  warnings: number;
  suggestions: number;
  violationsByCategory: Record<string, number>;
  topIssues: Array<{ type: string; count: number }>;
}

/** Compute a summary from a merged violation set (cached + fresh). */
export function summarizeViolations(violations: Violation[]): NextFileSummary {
  let criticalIssues = 0;
  let warnings = 0;
  let suggestions = 0;
  const violationsByCategory: Record<string, number> = {};
  for (const v of violations) {
    if (v.severity === 'critical') criticalIssues++;
    else if (v.severity === 'warning') warnings++;
    else if (v.severity === 'suggestion') suggestions++;
    const cat = v.analyzer || 'other';
    violationsByCategory[cat] = (violationsByCategory[cat] || 0) + 1;
  }
  const topIssues = Object.entries(violationsByCategory)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([type, count]) => ({ type, count }));
  return { totalViolations: violations.length, criticalIssues, warnings, suggestions, violationsByCategory, topIssues };
}

/** The three-violation arrays flattened into one, in a stable order. */
function flatten(s: NextFileSnapshot): Violation[] {
  return [...Object.values(s.visitorFindings).flat(), ...s.corpusFindings, ...s.schemaFindings];
}

/** Build a snapshot from a full-audit result split. */
function seedSnapshot(root: string, files: Record<string, FileRecord>, split: SplitResult): NextFileSnapshot {
  return {
    version: 1,
    projectRoot: root,
    files,
    visitorFindings: split.visitorFindings,
    corpusFindings: split.corpusFindings,
    schemaFindings: split.schemaFindings,
  };
}

/**
 * Orchestrate one `next-file` call. Cold (no snapshot) → full audit + seed.
 * Warm → hash current set, assert no stale files, re-audit only changed/added,
 * merge, and persist the refreshed snapshot. A warm call that touches a
 * schema-definition file escalates to a full re-seed (the schema catalog can
 * only be rebuilt correctly from the full corpus).
 */
export async function runNextFile(options: {
  projectRoot: string;
  configName?: string;
}): Promise<RunNextFileResult> {
  const root = resolve(options.projectRoot || process.cwd());

  // Load config (walk-up) so discovery matches what the audit actually sees.
  const configPath = await findConfigFileUp(root);
  const config = await loadConfig({ configPath: configPath ?? undefined });

  const discovered = await discoverFilesDetailed(root, {
    includePaths: config.includePaths,
    excludePaths: config.excludePaths,
  });
  const current = hashAndStatFiles(discovered.files, root);

  const db = CodeIndexDB.getInstance(undefined, root);
  await db.initialize();
  const raw = db.getMeta(SNAPSHOT_KEY);
  const snapshot: NextFileSnapshot | null = raw ? (JSON.parse(raw) as NextFileSnapshot) : null;

  // Shared full-audit-and-seed (cold path + schema escalation).
  const fullSeed = async (): Promise<RunNextFileResult> => {
    const runner = createAuditRunner({ projectRoot: root, configName: options.configName });
    const result = await runner.run();
    const split = splitFindings(result.analyzerResults, root);
    const seeded = seedSnapshot(root, current, split);
    db.setMeta(SNAPSHOT_KEY, JSON.stringify(seeded));
    return { snapshot: seeded, violations: flatten(seeded), cold: true, summary: summarizeViolations(flatten(seeded)) };
  };

  if (!snapshot) {
    return fullSeed();
  }

  const diff = diffFiles(snapshot.files, current);
  const stale = assertNoStaleFiles(snapshot.files, current, root);
  if (stale.length > 0) {
    const detail = stale
      .map((s) => `${s.file}: ${s.reason}`)
      .join('; ');
    throw new Error(
      `next-file: structural staleness check failed — the diff missed a change. ` +
        `Refusing to proceed with a stale cache. ${detail}`,
    );
  }

  if (diff.changed.length === 0 && diff.added.length === 0 && diff.deleted.length === 0) {
    // Nothing changed — reuse the cached queue wholesale.
    return { snapshot, violations: flatten(snapshot), cold: false, summary: summarizeViolations(flatten(snapshot)) };
  }

  const scopeFiles = [...diff.changed, ...diff.added].map((rel) => join(root, rel));
  const runner = createAuditRunner({
    projectRoot: root,
    configName: options.configName,
    scope: scopeFiles,
  });
  const result = await runner.run();
  const fresh = splitFindings(result.analyzerResults, root);

  // Schema catalog hazard: the known-tables catalog is rebuilt in-memory from a
  // run's visitor facts, so a scoped run only sees the tables *changed* files
  // define. If a changed/added file defined any table (a non-empty tableCatalog
  // in this scoped run) — or a schema-definition file was deleted — the catalog
  // may have shifted and must be rebuilt from the full corpus: escalate to a
  // full re-seed rather than return a silently-wrong unknown-table verdict.
  const schemaCatalogTouched = (result.metadata?.tableCatalog?.length ?? 0) > 0;
  const schemaDefinitionDeleted = diff.deleted.some((rel) =>
    SCHEMA_DEFINITION_EXTENSIONS.has(rel.slice(rel.lastIndexOf('.'))),
  );
  if (schemaCatalogTouched || schemaDefinitionDeleted) {
    return fullSeed();
  }

  const merged = mergeFindings({
    cachedVisitor: snapshot.visitorFindings,
    freshVisitor: fresh.visitorFindings,
    cachedCorpus: snapshot.corpusFindings,
    freshCorpus: fresh.corpusFindings,
    freshSchema: snapshot.schemaFindings,
    changed: diff.changed,
    added: diff.added,
    deleted: diff.deleted,
  });

  const refreshed: NextFileSnapshot = {
    version: 1,
    projectRoot: root,
    files: current,
    visitorFindings: merged.visitorFindings,
    corpusFindings: merged.corpusFindings,
    schemaFindings: merged.schemaFindings,
  };
  db.setMeta(SNAPSHOT_KEY, JSON.stringify(refreshed));
  return { snapshot: refreshed, violations: merged.all, cold: false, summary: summarizeViolations(merged.all) };
}

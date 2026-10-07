/**
 * Spec 70 Item 4 — re-run the env-rooted disposition split on a corpus.
 *
 * Enumerate every query-shaped call site whose receiver root is `env` (plain
 * `env.DB.prepare(…)` or `this.env.DB.prepare(…)` — `resolveReceiverRoot`
 * normalizes both to `env`), classify each through the production `identifyHandle`
 * seam, and tally the three-way disposition (handle / not-handle / unproven).
 *
 * This is the regression check Ben asked for after Q3's heritage arm moved ahead
 * of the binding lookup: "did any env-rooted site move in the wrong direction".
 * To isolate Q3's effect, each site is folded twice — once with the heritage arm
 * live (the `thisFieldType` the extraction seam threads) and once with it
 * disabled (`thisFieldType` forced to null, the pre-Q3 behaviour) — and the two
 * tallies are diffed. A movement is "wrong direction" only if a site moves to
 * `not-handle` or drops from `handle` to `unproven`; an `unproven` → `handle`
 * upgrade is exactly what Q3 is for.
 *
 * Enumeration uses the production `extractDataAccessCallCandidates` seam (the
 * broadened query-shaped discovery that already threads `thisField` /
 * `thisFieldType` / the handle SQL argument), so the per-site fold is the same
 * code the corpus producer re-folds. The per-file `RootResolutionEnv` uses the
 * production `classifyBuildProvenance` provenance (within-file + R3, empty
 * cross-file seed) — the same map the `data-access-calls` corpus consumer builds.
 *
 * Read-only. Usage:
 *   npx tsx scripts/measure-env-rooted-split.ts /path/to/corpus
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { LanguageRegistry } from '../src/languages/LanguageRegistry.js';
import { parseFile } from '../src/languages/adapterBridge.js';
import { discoverFiles, ALL_EXTENSIONS } from '../src/utils/fileDiscovery.js';
import { detectDialect } from '../src/languages/sql/dialectDetection.js';
import {
  buildBindingEnv,
  extractInterfaceFields,
  type RootResolutionEnv,
} from '../src/analyzers/receiverRoot.js';
import { extractR3Sites, extractTsWithinFileProvenance } from '../src/analyzers/provenance.js';
import { classifyBuildProvenance } from '../src/phase/receiverProvenance.js';
import { extractDataAccessCallCandidates } from '../src/analyzers/universal/UniversalDataAccessAnalyzer.js';
import { identifyHandle, type HandleVerdict } from '../src/analyzers/handleIdentification.js';
import type { Dialect } from '../src/mcp-tools/discoveryQueries.js';
import { assertCorpusPinned } from './corpus-pins.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: measure-env-rooted-split.ts <projectRoot>');
  process.exit(2);
}

const TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);

function relOf(root: string, p: string): string {
  return p.replace(root, '').replace(/^\//, '');
}

type Disposition = 'handle' | 'not-handle' | 'unproven';

interface EnvSite {
  file: string;
  line: number;
  receiver: string;
  method: string;
  thisField: boolean;
  thisFieldType: string | null;
  sqlArgument: string | null;
  live: Disposition;
  liveVia?: string;
  liveReason?: string;
  disabled: Disposition;
}

function fold(
  site: {
    root: string;
    receiver: string;
    method: string;
    sqlArgument: string | null;
    thisField: boolean;
    thisFieldType: string | null;
  },
  env: RootResolutionEnv,
  sqlDialect: Dialect | null,
): HandleVerdict {
  return identifyHandle(
    {
      format: 'typescript',
      root: site.root,
      receiver: site.receiver,
      method: site.method,
      sqlArgument: site.sqlArgument,
      thisField: site.thisField,
      thisFieldType: site.thisFieldType,
    },
    {
      imports: new Map(),
      typeAnnotations: new Map(),
      bindings: new Map(),
      withinFileProvenance: new Map(),
      sqlDialect,
      resolution: { dialect: 'ts', env },
    },
  );
}

function tally(sites: readonly EnvSite[]): Record<Disposition, number> {
  const out: Record<Disposition, number> = { handle: 0, 'not-handle': 0, unproven: 0 };
  for (const s of sites) out[s.live]++;
  return out;
}

async function main() {
  assertCorpusPinned(projectRoot);
  initializeLanguages();
  await initParsers();
  const registry = LanguageRegistry.getInstance();
  const files = await discoverFiles(projectRoot, { extensions: ALL_EXTENSIONS });
  const tsFiles = files.filter((f) => TS_EXTS.has(path.extname(f)));
  const sqlDialect: Dialect | null = detectDialect(projectRoot).dialect;

  const sites: EnvSite[] = [];

  for (const file of tsFiles) {
    const src = await readFile(file, 'utf8');
    const ast = parseFile(file, src);
    if (!ast) continue;
    const adapter = registry.getAdapterForFile(file);
    if (!adapter) {
      ast.dispose?.();
      continue;
    }

    const bindings = buildBindingEnv(ast, adapter, src);
    const interfaceFields = extractInterfaceFields(ast, adapter, src);
    const extract = extractTsWithinFileProvenance(ast, adapter, src);
    const r3Sites = extractR3Sites(ast, adapter, src);
    const dbProvenanced = classifyBuildProvenance(extract, new Map(), bindings, r3Sites, sqlDialect);
    const env = {
      provenance: dbProvenanced,
      bindings,
      interfaceFields,
      adapter: undefined,
      sourceCode: '',
    } as unknown as RootResolutionEnv;

    const candidates = extractDataAccessCallCandidates(ast, adapter, src);
    ast.dispose?.();

    for (const cand of candidates) {
      if (cand.format !== 'typescript') continue;
      if (cand.handleRoot !== 'env') continue;
      if (cand.handleReceiver === null || cand.handleMethod === null) continue;

      const site = {
        root: 'env',
        receiver: cand.handleReceiver,
        method: cand.handleMethod,
        sqlArgument: cand.handleSqlArg,
        thisField: cand.handleThisField,
        thisFieldType: cand.handleThisFieldType,
      };
      const live = fold(site, env, sqlDialect);
      const disabled = fold({ ...site, thisFieldType: null }, env, sqlDialect);

      sites.push({
        file: relOf(projectRoot, file),
        line: cand.line,
        receiver: cand.handleReceiver,
        method: cand.handleMethod,
        thisField: cand.handleThisField,
        thisFieldType: cand.handleThisFieldType,
        sqlArgument: cand.handleSqlArg,
        live: live.kind,
        liveVia: live.kind === 'handle' ? live.via : undefined,
        liveReason: live.kind === 'unproven' ? live.reason : undefined,
        disabled: disabled.kind,
      });
    }
  }

  // Dedup on (file, line) — the broadened discovery can emit a `.prepare()` and
  // its enclosing `.all()` on the same line as two candidates. Report raw and
  // deduped tallies so a count-vs-baseline comparison is not confounded.
  const dedup = new Map<string, EnvSite>();
  for (const s of sites) {
    const key = `${s.file}:${s.line}`;
    const prev = dedup.get(key);
    if (!prev || (s.sqlArgument !== null && prev.sqlArgument === null)) dedup.set(key, s);
  }
  const unique = [...dedup.values()];

  const liveRaw = tally(sites);
  const liveUnique = tally(unique);

  const moved = unique.filter((s) => s.live !== s.disabled);
  const wrongDirection = moved.filter(
    (s) => s.live === 'not-handle' || (s.disabled === 'handle' && s.live !== 'handle'),
  );

  const thisEnv = unique.filter((s) => s.thisField);
  const thisEnvLiteral = thisEnv.filter((s) => s.sqlArgument !== null);
  const thisEnvDynamic = thisEnv.filter((s) => s.sqlArgument === null);
  const thisEnvHeritage = thisEnv.filter((s) => s.thisFieldType !== null);

  console.log(`corpus: ${projectRoot}`);
  console.log(`env-rooted candidates: ${sites.length} raw / ${unique.length} deduped`);
  console.log(
    `  of which this.env: ${thisEnv.length} (${thisEnvLiteral.length} literal SQL, ${thisEnvDynamic.length} dynamic, ${thisEnvHeritage.length} heritage-resolved)`,
  );
  console.log('');
  console.log(`Q3 live (deduped)  : ${liveUnique.handle} handle / ${liveUnique['not-handle']} not-handle / ${liveUnique.unproven} unproven`);
  console.log(`Q3 live (raw)      : ${liveRaw.handle} handle / ${liveRaw['not-handle']} not-handle / ${liveRaw.unproven} unproven`);

  const disabledTally = tally(unique.map((s) => ({ ...s, live: s.disabled })));
  console.log(`Q3 disabled (dedup): ${disabledTally.handle} handle / ${disabledTally['not-handle']} not-handle / ${disabledTally.unproven} unproven`);

  console.log('');
  console.log(`sites Q3 moved: ${moved.length}`);
  for (const s of moved) {
    console.log(`  ${s.disabled} -> ${s.live}  ${s.file}:${s.line}  ${s.receiver}.${s.method}  (thisField=${s.thisField}, type=${s.thisFieldType ?? '-'})`);
  }
  console.log(`wrong-direction moves: ${wrongDirection.length}`);
  for (const s of wrongDirection) {
    console.log(`  !!! ${s.file}:${s.line}  ${s.receiver}.${s.method}  ${s.disabled} -> ${s.live}`);
  }

  const handleVia = new Map<string, number>();
  for (const s of unique) {
    if (s.live === 'handle') handleVia.set(s.liveVia ?? '?', (handleVia.get(s.liveVia ?? '?') ?? 0) + 1);
  }
  console.log('');
  console.log(`handle via (deduped): ${[...handleVia.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);

  const unproven = unique.filter((s) => s.live === 'unproven');
  console.log('');
  console.log(`=== ${unproven.length} unproven env sites ===`);
  for (const s of unproven) {
    console.log(`  ${s.file}:${s.line}  ${s.receiver}.${s.method}  this=${s.thisField} type=${s.thisFieldType ?? '-'} sql=${s.sqlArgument !== null}`);
    console.log(`      ${s.liveReason ?? '(no reason)'}`);
  }

  if (thisEnvDynamic.length > 0) {
    console.log('');
    console.log('=== this.env dynamic sites (sqlArgument null — where Q3 can matter) ===');
    for (const s of thisEnvDynamic) {
      console.log(`  ${s.file}:${s.line}  ${s.receiver}.${s.method}  type=${s.thisFieldType ?? '-'}  ${s.disabled} -> ${s.live}`);
    }
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});

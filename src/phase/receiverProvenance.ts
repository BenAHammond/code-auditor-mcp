/**
 * Spec 70 Item 4 (2a) — the `receiver-provenance` corpus producer.
 *
 * Re-derives the cross-file DB-receiver provenance fixed point from the four
 * additive file facts (`within-file-provenance`, `import-specifiers`,
 * `export-symbols`, `go-package-bindings`) with no AST and no second parse. This
 * is the phase-side replacement for `resolveCorpusReceivers`' `fileProvenance` +
 * `unresolvedImports` halves: per-file DB-provenanced identifiers the four
 * receiver consumers read, plus the unresolved DB-looking imports the
 * `cannot-fire` diagnostic names.
 *
 * The fixed point mirrors the legacy resolver's Phase 1/2/3 + the
 * unresolved-import pass, but rehydrates the extract projections through the
 * same seam the file producer extracted them with
 * (`RESOLUTION_IMPLEMENTATIONS[format].classify(extract, …)`), so the result is
 * byte-identical to `computeTsWithinFileProvenance` (the within-file fixed point
 * kept in receiverResolution.ts as the parity reference) by construction. The
 * legacy `resolveCorpusReceivers` path and its
 * `spec70-receiver-provenance-parity.spec.ts` are deleted; the remaining pins
 * are `spec70-ts-within-file-parity.spec.ts`,
 * `spec70-classify-build-provenance-parity.spec.ts`, and
 * `spec70-unresolved-query-parity.spec.ts`.
 */

import path from 'node:path';
import type {
  WithinFileProvenanceFact,
  TsWithinFileProvenanceProjection,
  GoWithinFileProvenanceProjection,
  ImportSpecifiersFact,
  ExportSymbolFact,
  GoPackageBindingFact,
  GoPackageBinding,
  ProvenanceEvidenceFact,
  TsBindingFact,
} from './types.js';
import type { ProvenanceEvidence, R3Site } from '../analyzers/provenance.js';
import {
  RESOLUTION_IMPLEMENTATIONS,
  identifyHandle,
  type WithinFileProvenanceExtract,
  type GoWithinFileProvenanceExtract,
} from '../analyzers/handleIdentification.js';
import {
  propagateProvenanceFromExtract,
  detectDbWrapperFunctionsFromExtract,
  type TsWithinFileProvenanceExtract,
} from '../analyzers/tsExpressionDescriptor.js';
import type { RootResolutionEnv, Binding } from '../analyzers/receiverRoot.js';
import type { Dialect } from '../mcp-tools/discoveryQueries.js';
import {
  resolveSpecifier,
  type FileProvenance,
  type FileExports,
  type UnresolvedImport,
} from '../analyzers/receiverResolution.js';
import type { GoBinding } from '../languages/go/goResolution.js';
import { evidenceToFact } from './withinFileProvenance.js';

// ── Rehydrators — fact → the seam's classify input, no translation ───────────

/** Rehydrate a `ProvenanceEvidenceFact` (type) back to `ProvenanceEvidence`
 *  (interface). The `reason` cast is lossless (a string-literal union at runtime);
 *  `chain` is copied so the interface's mutable array never aliases the fact's
 *  `readonly` one. */
export function evidenceFromFact(f: ProvenanceEvidenceFact): ProvenanceEvidence {
  const base = { identifier: f.identifier, reason: f.reason, source: f.source, chain: [...f.chain] };
  return f.packageName === undefined ? base : { ...base, packageName: f.packageName };
}

/** Rehydrate a `TsBindingFact` back to the `Binding` interface. Exported so the
 *  `receiver-activity` rehydrator (receiverConsumers.ts) reads bindings through the
 *  *same* mapping — one rehydration, not two that could drift. The two are
 *  structurally identical (`TsBindingFact` is the §4 projection of `Binding`, whose
 *  `value` is already the serializable `ValueDescriptor`), so the reconstruction is
 *  lossless. */
export function bindingFromFact(b: TsBindingFact): Binding {
  return {
    kind: b.kind,
    ...(b.source !== undefined ? { source: b.source } : {}),
    ...(b.importKind !== undefined ? { importKind: b.importKind } : {}),
    ...(b.typeText !== undefined ? { typeText: b.typeText } : {}),
    ...(b.value !== undefined ? { value: b.value } : {}),
  };
}

/** Rehydrate a `GoPackageBindingDetail` back to the `GoBinding` interface the Go
 *  classifier reads. The two are structurally identical (the detail is the §4
 *  serializable projection of the interface; `GoPackageValueDescriptor` mirrors
 *  `GoValueDescriptor` byte-for-byte), so the cast is lossless. */
function goBindingFromFact(b: GoPackageBinding['binding']): GoBinding {
  return b as unknown as GoBinding;
}

/** The TS extract's two non-serializable members (`seeds` Map, `localFunctions`
 *  Set) are the only fields that need re-projection; the four array fields are
 *  already the closed object-literal `type`s the classifier reads, passed through
 *  verbatim. */
function tsExtractFromFact(p: TsWithinFileProvenanceProjection): TsWithinFileProvenanceExtract {
  return {
    seeds: new Map(p.seeds.map((e) => [e.identifier, evidenceFromFact(e)])),
    bindings: new Map(p.bindings.map((b) => [b.name, bindingFromFact(b)])),
    localFunctions: new Set(p.localFunctions),
    propagationRules: p.propagationRules,
    wrapperFunctions: p.wrapperFunctions,
    wrapperClasses: p.wrapperClasses,
    returningFunctions: p.returningFunctions,
    interfaceFields: new Map(
      p.interfaceFields.map((i) => [i.name, new Map(i.fields.map((f) => [f.name, f.typeText]))]),
    ),
  };
}

/** The Go extract's two Maps, rebuilt from their `{name, …}` pair arrays. */
function goExtractFromFact(p: GoWithinFileProvenanceProjection): GoWithinFileProvenanceExtract {
  return {
    imports: new Map(p.imports.map((i) => [i.name, i.source])),
    bindings: new Map(p.bindings.map((b) => [b.name, goBindingFromFact(b.binding)])),
  };
}

/** Rehydrate one file's within-file-provenance fact into its format's extract,
 *  tagged `ts`/`go` so `classify` correlates it back to the owning implementation. */
export function rehydrateWithinFileProvenance(fact: WithinFileProvenanceFact): WithinFileProvenanceExtract {
  if (fact.format === 'go') return { kind: 'go', projection: goExtractFromFact(fact.go) };
  return { kind: 'ts', projection: tsExtractFromFact(fact.ts) };
}

/** Group the per-file `go-package-bindings` facts by directory and merge
 *  first-wins — the exact `buildGoPackageBindingsByDir` + `buildGoPackageBindings`
 *  composition the legacy Go arm fed its classify call, rebuilt with no AST. */
function goPackageBindingsByDir(
  goPackageFacts: readonly GoPackageBindingFact[],
): Map<string, ReadonlyMap<string, GoBinding>> {
  const byDir = new Map<string, Map<string, GoBinding>>();
  for (const f of goPackageFacts) {
    const dir = path.dirname(f.file);
    let map = byDir.get(dir);
    if (!map) {
      map = new Map();
      byDir.set(dir, map);
    }
    for (const { name, binding } of f.bindings) {
      if (!map.has(name)) map.set(name, goBindingFromFact(binding));
    }
  }
  return byDir;
}

// ── The fixed point ──────────────────────────────────────────────────────────

/** The `moduleEvidence` the legacy fixed point seeds cross-file imports with.
 *  Replicated (not imported — it is private in receiverResolution.ts) so the
 *  evidence string is byte-identical. */
function moduleEvidence(identifier: string, source: string): ProvenanceEvidence {
  return {
    identifier,
    reason: 'module',
    source: `import from ${source} (in-repo declaration)`,
    chain: [],
  };
}

/** Re-derive one file's exported DB-provenanced names from the `export-symbols`
 *  fact and the file's provenance — the `exportedProvenancedNames` mirror that
 *  reads the serializable export set instead of walking the AST. */
function exportedProvenancedNames(
  file: string,
  exports: readonly ExportSymbolFact[],
  provenance: ReadonlyMap<string, ProvenanceEvidence>,
): Set<string> {
  const out = new Set<string>();
  for (const ex of exports) {
    if (ex.file !== file) continue;
    if (ex.name === '*') continue; // export * is handled by the module-level star
    if (provenance.has(ex.name)) out.add(ex.name);
  }
  return out;
}

/** The cross-file fixed-point core. Re-derives `fileProvenance` / `fileExports` /
 *  `unresolvedImports` from the four file facts, mirroring
 *  `resolveReceiverProvenance` Phase 1 (within-file) → Phase 2 (exported names) →
 *  Phase 3 (≤20-iteration cross-file fixed point) → the unresolved-import pass.
 *
 *  `filesByPath` is derived from the within-file-provenance facts themselves —
 *  they are exactly the parsed code files the legacy pass resolved against, and
 *  only TS/JS specifiers are ever resolved (`RESOLVE_EXTENSIONS`), so the Go
 *  test-file exemption in the producer is invisible to specifier resolution.
 *
 * @param withinFacts the `within-file-provenance` facts (one per code file)
 * @param importFacts the `import-specifiers` facts (one per import statement)
 * @param exportFacts the `export-symbols` facts (one per exported symbol)
 * @param goPackageFacts the `go-package-bindings` facts (one per Go file)
 * @param projectRoot the corpus root (for `@/`/`~/` alias specifiers), optional
 * @returns the fixed-point provenance maps + unresolved imports, in the legacy
 *   `FileProvenance`/`FileExports`/`UnresolvedImport` types (the parity assertion
 *   compares these directly against `resolveReceiverProvenance`)
 */
export function computeReceiverProvenance(
  withinFacts: readonly WithinFileProvenanceFact[],
  importFacts: readonly ImportSpecifiersFact[],
  exportFacts: readonly ExportSymbolFact[],
  goPackageFacts: readonly GoPackageBindingFact[],
  projectRoot?: string,
): { fileProvenance: FileProvenance; fileExports: FileExports; unresolvedImports: UnresolvedImport[] } {
  const filesByPath = new Set(withinFacts.map((f) => f.file));
  const goBindings = goPackageBindingsByDir(goPackageFacts);

  const importsByFile = new Map<string, ImportSpecifiersFact[]>();
  for (const imp of importFacts) {
    const list = importsByFile.get(imp.file) ?? [];
    list.push(imp);
    importsByFile.set(imp.file, list);
  }
  const exportsByFile = new Map<string, ExportSymbolFact[]>();
  for (const ex of exportFacts) {
    const list = exportsByFile.get(ex.file) ?? [];
    list.push(ex);
    exportsByFile.set(ex.file, list);
  }

  // Phase 1 — within-file provenance only (package + type + propagation + wrapper).
  const fileProvenance: FileProvenance = new Map();
  for (const fact of withinFacts) {
    const extract = rehydrateWithinFileProvenance(fact);
    fileProvenance.set(
      fact.file,
      RESOLUTION_IMPLEMENTATIONS[fact.format].classify(extract, new Map(), goBindings.get(path.dirname(fact.file))),
    );
  }

  // Phase 2 — exported provenanced names.
  const fileExports: FileExports = new Map();
  for (const fact of withinFacts) {
    fileExports.set(fact.file, exportedProvenancedNames(fact.file, exportsByFile.get(fact.file) ?? [], fileProvenance.get(fact.file)!));
  }

  // Phase 3 — fixed point over cross-file imports.
  const MAX_ITERATIONS = 20;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let changed = false;
    for (const fact of withinFacts) {
      const file = fact.file;
      const extraSeeds = new Map<string, ProvenanceEvidence>();
      for (const imp of importsByFile.get(file) ?? []) {
        const target = resolveSpecifier(imp.source, file, filesByPath, projectRoot);
        if (!target) continue;
        const targetExports = fileExports.get(target);
        if (!targetExports || targetExports.size === 0) continue;
        for (const spec of imp.specifiers) {
          const localName = spec.alias ?? spec.name;
          // Namespace import (`import * as db from './x'`) — provenanced when the
          // module exports ANY provenanced name (it re-exposes DB handles).
          if (spec.isNamespace) {
            if (!extraSeeds.has(localName)) extraSeeds.set(localName, moduleEvidence(localName, imp.source));
            continue;
          }
          const exportedName = spec.name;
          if (targetExports.has(exportedName) || (spec.isDefault && targetExports.has('default'))) {
            if (!extraSeeds.has(localName)) extraSeeds.set(localName, moduleEvidence(localName, imp.source));
          }
        }
      }
      if (extraSeeds.size === 0) continue;

      const prev = fileProvenance.get(file)!;
      const extract = rehydrateWithinFileProvenance(fact);
      const next = RESOLUTION_IMPLEMENTATIONS[fact.format].classify(extract, extraSeeds, goBindings.get(path.dirname(file)));
      // Recompute exports against the new provenance; a changed export set
      // propagates further on a later iteration.
      const nextExports = exportedProvenancedNames(file, exportsByFile.get(file) ?? [], next);
      const prevExports = fileExports.get(file)!;
      let exportChanged = nextExports.size !== prevExports.size;
      if (!exportChanged) {
        for (const n of nextExports) if (!prevExports.has(n)) { exportChanged = true; break; }
      }
      if (next.size > prev.size || exportChanged) {
        fileProvenance.set(file, next);
        fileExports.set(file, nextExports);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Collect unresolved imports for the cannot-fire report.
  const unresolvedImports: UnresolvedImport[] = [];
  for (const imp of importFacts) {
    const target = resolveSpecifier(imp.source, imp.file, filesByPath, projectRoot);
    if (target) continue;
    const names = imp.specifiers.map((s) => s.alias ?? s.name);
    // Only DB-looking imports matter: a bare package specifier is already
    // covered by DB_PACKAGES; an in-repo-looking specifier that fails to
    // resolve is the cannot-fire signal.
    if (imp.source.startsWith('./') || imp.source.startsWith('../') || imp.source.startsWith('@/') || imp.source.startsWith('~/')) {
      unresolvedImports.push({ importer: imp.file, source: imp.source, names });
    }
  }

  return { fileProvenance, fileExports, unresolvedImports };
}

// ── Build-side provenance mirror (Spec 70 Item 4, step 3) ────────────────────

/**
 * Re-derive `buildProvenanceContext`'s `dbProvenanced` — the seeded map the four
 * receiver consumers actually read — from the within-file extract + the cross-file
 * seed + the receiver-activity fact, with no AST. This is the *build-side* mirror,
 * distinct from `classifyTsWithinFileProvenance` (the classify side): the build
 * side runs R3 (sql-argument) and stops at *function* wrappers (no classes, no
 * returning functions), while the classify side scans classes and returning
 * functions and skips R3. `propagateProvenanceFromExtract` +
 * `detectDbWrapperFunctionsFromExtract` mirror steps 2 and 4; `applyR3FromSites`
 * mirrors step 3.
 *
 * @param extract the file's rehydrated within-file extract (seeds + propagation
 *   rules + function wrappers)
 * @param seedProvenance the file's cross-file provenanced names (from the
 *   `receiver-provenance` fixed point's `files[file].provenance`)
 * @param bindings the file's rehydrated binding environment
 * @param r3Sites the file's R3 sites (from the `receiver-activity` fact)
 * @param sqlDialect the corpus's named dialect, or null to parse under the default
 * @returns the file's DB-provenanced name map after the within-file fixed point
 */
export function classifyBuildProvenance(
  extract: TsWithinFileProvenanceExtract,
  seedProvenance: ReadonlyMap<string, ProvenanceEvidence>,
  bindings: ReadonlyMap<string, Binding>,
  r3Sites: readonly R3Site[],
  sqlDialect: Dialect | null,
): Map<string, ProvenanceEvidence> {
  // 1 + 1a. Within-file seeds ∪ cross-file seed.
  let prov = new Map(extract.seeds);
  for (const [name, evidence] of seedProvenance) {
    if (!prov.has(name)) prov.set(name, evidence);
  }

  // 2. Propagate through assignments (mirror of `propagateProvenance`).
  prov = propagateProvenanceFromExtract(extract, prov);

  // 3. R3 — runs even without a named dialect: `identifyHandle` parses the
  //    literal under DEFAULT_SQL_DIALECT when the dialect is null (Spec 70 R2).
  prov = applyR3FromSites(r3Sites, bindings, prov, sqlDialect, extract.interfaceFields);

  // 4. Function wrappers only (mirror of `detectDbWrappers` without classes).
  prov = detectDbWrapperFunctionsFromExtract(extract, prov);

  return prov;
}

/**
 * Corpus-side mirror of `applySqlArgumentInference` (R3): fold `identifyHandle`
 * over the serialized R3 sites with the seeded provenance + rehydrated bindings.
 * The `adapter`/`sourceCode` fields of the `RootResolutionEnv` are never read by
 * `classifyRootIdentifier` (it reads only `provenance` + `bindings` + optional
 * `resolveImport`, and `typescriptResolution.resolveRoot` passes no `resolveImport`),
 * so the mirror leaves them unset via a cast — the classification is byte-identical
 * to the build-side step that had the live adapter. Site order is the walk pre-order,
 * preserved by `extractR3Sites`, so each verdict reads the same progressively-grown
 * map the build-side walk did.
 */
function applyR3FromSites(
  r3Sites: readonly R3Site[],
  bindings: ReadonlyMap<string, Binding>,
  dbProvenanced: Map<string, ProvenanceEvidence>,
  sqlDialect: Dialect | null,
  interfaceFields: ReadonlyMap<string, ReadonlyMap<string, string>> | undefined,
): Map<string, ProvenanceEvidence> {
  const env = { provenance: dbProvenanced, bindings, interfaceFields, adapter: undefined, sourceCode: '' } as unknown as RootResolutionEnv;

  for (const site of r3Sites) {
    const verdict = identifyHandle(
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

    if (verdict.kind === 'handle' && !dbProvenanced.has(site.root)) {
      dbProvenanced.set(site.root, {
        identifier: site.root,
        reason: 'sql-argument',
        source: 'SQL argument parses as a statement (Spec 70 R3)',
        chain: [],
      });
    }
  }

  return dbProvenanced;
}

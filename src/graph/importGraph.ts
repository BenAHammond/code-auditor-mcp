/**
 * Spec 14 R3, R4 — Import Graph, Community Detection, and Martin Metrics
 *
 * Builds a file-level import graph from `function_dependencies`, runs Louvain
 * community detection, computes directory purity vs community structure, and
 * calculates Martin instability/abstractness metrics.
 *
 * IMPORTANT (R4 abstractness gate): The `functions` entity_type column stores
 * only 'function' and 'component' — NOT type/interface declarations. Abstractness (A)
 * is computed from `is_exported` rows using a per-file AST scan for export type/interface
 * declarations. Without this, A = 0 everywhere (dead path).
 *
 * All advisory — zero violations. Reports and annotations only.
 */

import type Database from 'better-sqlite3';
import type { DirectoryPurity, MartinEntry } from '../types.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface ImportGraph {
  /** Adjacency: filePath → (neighborFilePath → edgeWeight) */
  adjacency: Map<string, Map<string, number>>;
  /** Set of all file paths in the graph */
  filePaths: Set<string>;
}

export interface CommunityResult {
  /** filePath → community ID */
  communities: Map<string, number>;
  /** Number of communities detected */
  communityCount: number;
  /** Final modularity score */
  modularity: number;
}

export interface PurityResult {
  directoryPurities: DirectoryPurity[];
  splitCandidates: Array<{ directory: string; communities: number[]; fileCounts: number[] }>;
  mergeCandidates: Array<{ directories: string[]; community: number; fileCount: number }>;
  agreementScore: number;
}

// ── R1 — Import graph construction ──────────────────────────────────────

/**
 * Build a file-level import graph by aggregating `function_dependencies`
 * joined with `functions.file_path`.
 *
 * Edge weight = count of distinct dependency symbols between a file pair.
 */
export function buildImportGraph(db: Database.Database): ImportGraph {
  const adjacency = new Map<string, Map<string, number>>();

  // Collect all files with indexed functions
  const files = db.prepare(
    'SELECT DISTINCT file_path FROM functions'
  ).all() as Array<{ file_path: string }>;

  const filePaths = new Set<string>();
  for (const row of files) {
    filePaths.add(row.file_path);
  }

  // Aggregate import edges: for each function, its dependencies map to
  // the files those dependencies likely resolve to (module/file resolution)
  const rows = db.prepare(`
    SELECT
      f.file_path AS source_file,
      fd.dependency
    FROM function_dependencies fd
    JOIN functions f ON f.id = fd.function_id
    ORDER BY f.file_path, fd.dependency
  `).all() as Array<{ source_file: string; dependency: string }>;

  // Group by (source_file, dependency) — weight = count of imports
  const edgeWeights = new Map<string, Map<string, number>>();

  for (const row of rows) {
    if (!edgeWeights.has(row.source_file)) {
      edgeWeights.set(row.source_file, new Map());
    }
    const inner = edgeWeights.get(row.source_file)!;
    inner.set(row.dependency, (inner.get(row.dependency) ?? 0) + 1);
  }

  // Now resolve each dependency to a file in the project
  // Build a lookup: module name → file path
  const moduleToFile = new Map<string, Set<string>>();

  // First pass: build a dependency → file lookup by matching dependency names
  // against file basenames
  for (const fp of filePaths) {
    const basename = basenameNoExt(fp);
    if (!moduleToFile.has(basename)) {
      moduleToFile.set(basename, new Set());
    }
    moduleToFile.get(basename)!.add(fp);
  }

  // Second pass: resolve import edges
  for (const [sourceFile, depMap] of edgeWeights) {
    if (!adjacency.has(sourceFile)) {
      adjacency.set(sourceFile, new Map());
    }

    for (const [dep, weight] of depMap) {
      // Try to resolve the dependency to a file
      const targets = resolveDependency(dep, filePaths, moduleToFile, sourceFile);

      for (const target of targets) {
        if (target === sourceFile) continue; // Skip self-loops

        if (!adjacency.has(sourceFile)) {
          adjacency.set(sourceFile, new Map());
        }
        const adjMap = adjacency.get(sourceFile)!;
        adjMap.set(target, (adjMap.get(target) ?? 0) + weight);
      }
    }
  }

  return { adjacency, filePaths };
}

function basenameNoExt(fp: string): string {
  const segments = fp.replace(/\\/g, '/').split('/');
  const basename = segments[segments.length - 1];
  const dot = basename.lastIndexOf('.');
  return dot > 0 ? basename.substring(0, dot) : basename;
}

/**
 * Resolve a dependency name to a set of file paths.
 *
 * Tries multiple strategies:
 * 1. Exact file path match
 * 2. Module name matching (npm package → search path patterns)
 * 3. Relative import resolution
 * 4. Basename matching
 */
function resolveDependency(
  dep: string,
  filePaths: Set<string>,
  moduleToFile: Map<string, Set<string>>,
  sourceFile: string
): string[] {
  const results: string[] = [];

  // Strategy 1: Exact file path match
  if (filePaths.has(dep)) {
    return [dep];
  }

  // Strategy 2: Check if dep is a relative path
  if (dep.startsWith('.') || dep.startsWith('/')) {
    // Resolve relative to source file directory
    const sourceDir = sourceFile.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    const resolved = normalizePath(sourceDir ? `${sourceDir}/${dep}` : dep);
    // Try with various extensions
    for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx']) {
      const candidate = resolved + ext;
      if (filePaths.has(candidate)) {
        return [candidate];
      }
    }

    // Partial match: check if any file starts with the resolved path
    for (const fp of filePaths) {
      if (fp.startsWith(resolved + '/') || fp === resolved) {
        results.push(fp);
      }
    }
    return results;
  }

  // Strategy 3: Module name matching — try to find project files with matching
  // directory/package names
  const depParts = dep.split('/');
  const lastName = depParts[depParts.length - 1];

  // Check moduleToFile for the last segment
  const candidates = moduleToFile.get(lastName);
  if (candidates) {
    // Filter: prefer files whose path contains the dep name
    for (const fp of candidates) {
      if (fp.includes('/' + dep + '/') || fp.includes('/' + dep + '.')) {
        results.push(fp);
      }
    }
    // If no strong matches, prefer files not in the source directory
    if (results.length === 0) {
      for (const fp of candidates) {
        results.push(fp);
      }
    }
    return results;
  }

  // Strategy 4: Fuzzy matching — check if dep appears as a file path segment
  for (const fp of filePaths) {
    const segments = fp.replace(/\\/g, '/').split('/');
    if (segments.includes(lastName) || segments.includes(dep)) {
      results.push(fp);
    }
  }

  return results;
}

function normalizePath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  const result: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      result.pop();
    } else if (part !== '.' && part !== '') {
      result.push(part);
    }
  }
  return result.join('/');
}

/**
 * Populate `graph_cache` with import graph edges.
 */
export function populateImportGraphCache(db: Database.Database): void {
  const { adjacency } = buildImportGraph(db);

  const txn = db.transaction(() => {
    db.prepare("DELETE FROM graph_cache WHERE graph_type = 'import'").run();

    const stmt = db.prepare(
      `INSERT OR REPLACE INTO graph_cache (graph_type, node_key, neighbor_key, weight)
       VALUES ('import', ?, ?, ?)`
    );

    for (const [sourceFile, neighbors] of adjacency) {
      for (const [targetFile, weight] of neighbors) {
        stmt.run(sourceFile, targetFile, weight);
      }
    }
  });
  txn();
}

/**
 * Build an import graph from the persistent `graph_cache` table (fast path).
 */
export function buildImportGraphFromCache(db: Database.Database): ImportGraph {
  const adjacency = new Map<string, Map<string, number>>();
  const filePaths = new Set<string>();

  const rows = db.prepare(
    `SELECT node_key, neighbor_key, weight FROM graph_cache WHERE graph_type = 'import'`
  ).all() as Array<{ node_key: string; neighbor_key: string; weight: number }>;

  for (const row of rows) {
    filePaths.add(row.node_key);
    filePaths.add(row.neighbor_key);
    if (!adjacency.has(row.node_key)) adjacency.set(row.node_key, new Map());
    adjacency.get(row.node_key)!.set(row.neighbor_key, row.weight);
  }

  return { adjacency, filePaths };
}

// ── R3 — Louvain community detection ────────────────────────────────────

/**
 * Louvain community detection on weighted undirected graph.
 *
 * Standard two-phase algorithm:
 * Phase 1: Greedy modularity optimization (move nodes between communities)
 * Phase 2: Community aggregation (build super-graph)
 * Repeat until modularity gain < threshold.
 */
export function detectCommunities(
  adjacency: Map<string, Map<string, number>>,
  filePaths: Set<string>
): CommunityResult {
  // Convert to undirected weighted graph
  // For each directed edge, add reverse if not present
  const undirected = new Map<string, Map<string, number>>();

  for (const [src, neighbors] of adjacency) {
    if (!undirected.has(src)) undirected.set(src, new Map());
    const srcMap = undirected.get(src)!;

    for (const [dst, weight] of neighbors) {
      srcMap.set(dst, (srcMap.get(dst) ?? 0) + weight);

      // Add reverse edge
      if (!undirected.has(dst)) undirected.set(dst, new Map());
      const dstMap = undirected.get(dst)!;
      dstMap.set(src, (dstMap.get(src) ?? 0) + weight);
    }
  }

  const files = [...filePaths];
  const N = files.length;
  if (N === 0) {
    return { communities: new Map(), communityCount: 0, modularity: 0 };
  }

  // Map file → index for fast access
  const fileToIdx = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    fileToIdx.set(files[i], i);
  }

  // Initialize: each node in its own community
  let communities = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    communities.set(files[i], i);
  }

  // Compute total edge weight (m) for modularity normalization
  let m2 = 0; // 2 × m (undirected, each edge counted twice)
  for (const [, neighbors] of undirected) {
    for (const weight of neighbors.values()) {
      m2 += weight;
    }
  }

  if (m2 === 0) {
    return { communities, communityCount: N, modularity: 0 };
  }

  // Compute weighted degree for each node
  const weightedDegree = new Map<string, number>();
  for (const [node, neighbors] of undirected) {
    let deg = 0;
    for (const w of neighbors.values()) deg += w;
    weightedDegree.set(node, deg);
  }

  const MODULARITY_THRESHOLD = 1e-5;
  let currentModularity = computeModularity(undirected, communities, m2, weightedDegree);
  let improved = true;

  // Louvain iteration
  while (improved) {
    improved = false;

    // Phase 1: Move nodes between communities
    let phaseImproved = true;
    while (phaseImproved) {
      phaseImproved = false;

      for (const node of files) {
        const nodeComm = communities.get(node)!;

        // Compute best community for this node
        const neighborComms = new Map<number, number>(); // commId → edgeWeightSum
        const nodeNeighbors = undirected.get(node);
        if (nodeNeighbors) {
          for (const [neighbor, weight] of nodeNeighbors) {
            const neighborComm = communities.get(neighbor);
            if (neighborComm !== undefined) {
              neighborComms.set(
                neighborComm,
                (neighborComms.get(neighborComm) ?? 0) + weight
              );
            }
          }
        }

        // Compute current modularity contribution of node to its community
        const ki = weightedDegree.get(node) ?? 0;

        // Total weight of edges from node to community
        const toSelf = neighborComms.get(nodeComm) ?? 0;

        // Compute sigma_tot for current community
        let sigmaTotCurrent = 0;
        for (const [n, comm] of communities) {
          if (comm === nodeComm && n !== node) {
            sigmaTotCurrent += weightedDegree.get(n) ?? 0;
          }
        }

        // Remove node from its community and check gain
        let bestComm = nodeComm;
        let bestGain = 0;

        for (const [comm, kiIn] of neighborComms) {
          if (comm === nodeComm) continue;

          // Compute sigma_tot for candidate community
          let sigmaTotComm = 0;
          for (const [n, c] of communities) {
            if (c === comm) {
              sigmaTotComm += weightedDegree.get(n) ?? 0;
            }
          }

          // Modularity gain of moving node to comm
          const gain =
            (kiIn / (m2 / 2)) -
            ((sigmaTotComm * ki) / (m2 * m2 / 4)) -
            (toSelf / (m2 / 2)) +
            ((sigmaTotCurrent * ki) / (m2 * m2 / 4));

          if (gain > bestGain) {
            bestGain = gain;
            bestComm = comm;
          }
        }

        if (bestComm !== nodeComm) {
          communities.set(node, bestComm);
          phaseImproved = true;
          improved = true;
        }
      }
    }

    // Phase 2: Aggregate communities into super-graph
    // Count communities
    const commSet = new Set(communities.values());
    const newCommCount = commSet.size;

    // Map old comm → new index
    const commToNew = new Map<number, number>();
    let idx = 0;
    for (const c of commSet) {
      commToNew.set(c, idx++);
    }

    // Build super-graph adjacency
    const superAdj = new Map<string, Map<string, number>>();
    for (const [node, neighbors] of undirected) {
      const srcComm = commToNew.get(communities.get(node)!)!;
      const srcKey = String(srcComm);

      if (!superAdj.has(srcKey)) superAdj.set(srcKey, new Map());

      for (const [neighbor, weight] of neighbors) {
        const dstComm = commToNew.get(communities.get(neighbor)!);
        if (dstComm === undefined) continue;
        const dstKey = String(dstComm);
        if (srcKey === dstKey) continue; // Self-loop

        const inner = superAdj.get(srcKey)!;
        inner.set(dstKey, (inner.get(dstKey) ?? 0) + weight);
      }
    }

    // If no aggregation happened (communities stayed same), break
    if (newCommCount === N) break;

    // Update for next iteration: remap communities
    const newCommunities = new Map<string, number>();
    for (const node of files) {
      newCommunities.set(node, commToNew.get(communities.get(node)!)!);
    }
    communities = newCommunities;

    // Recompute modularity
    const newModularity = computeModularity(undirected, communities, m2, weightedDegree);
    if (newModularity - currentModularity < MODULARITY_THRESHOLD) {
      break;
    }
    currentModularity = newModularity;
  }

  return {
    communities,
    communityCount: new Set(communities.values()).size,
    modularity: currentModularity,
  };
}

/**
 * Compute modularity Q for a given community assignment.
 */
function computeModularity(
  adjacency: Map<string, Map<string, number>>,
  communities: Map<string, number>,
  m2: number,
  weightedDegree: Map<string, number>
): number {
  let Q = 0;

  for (const [node, neighbors] of adjacency) {
    const commI = communities.get(node);
    if (commI === undefined) continue;
    const ki = weightedDegree.get(node) ?? 0;

    for (const [neighbor, weight] of neighbors) {
      const commJ = communities.get(neighbor);
      if (commJ === undefined) continue;

      if (commI === commJ) {
        const kj = weightedDegree.get(neighbor) ?? 0;
        Q += weight - (ki * kj) / m2;
      }
    }
  }

  return Q / m2;
}

// ── R3 — Directory purity ───────────────────────────────────────────────

const COMMUNITY_MIN_FILES = 5;

/**
 * Compute directory purity against detected communities.
 *
 * For each directory, compute: share of its files in the plurality community.
 * Detects split candidates (directories spanning ≥2 communities) and
 * merge candidates (one community dominating ≥2 directories).
 */
export function computeDirectoryPurity(
  communities: Map<string, number>,
  filePaths: Set<string>
): PurityResult {
  // Group files by directory
  const dirFiles = new Map<string, string[]>();
  for (const fp of filePaths) {
    const dir = dirname(fp);
    if (!dirFiles.has(dir)) dirFiles.set(dir, []);
    dirFiles.get(dir)!.push(fp);
  }

  const directoryPurities: DirectoryPurity[] = [];
  const splitCandidates: PurityResult['splitCandidates'] = [];
  const mergeCandidates: PurityResult['mergeCandidates'] = [];

  // Per-directory purity
  for (const [dir, files] of dirFiles) {
    if (files.length === 0) continue;

    const commCounts = new Map<number, number>();
    for (const fp of files) {
      const comm = communities.get(fp);
      if (comm !== undefined) {
        commCounts.set(comm, (commCounts.get(comm) ?? 0) + 1);
      }
    }

    if (commCounts.size === 0) continue;

    // Find plurality community
    let pluralityComm = -1;
    let pluralityCount = 0;
    for (const [comm, count] of commCounts) {
      if (count > pluralityCount) {
        pluralityCount = count;
        pluralityComm = comm;
      }
    }

    const purity = pluralityCount / files.length;

    directoryPurities.push({
      directory: dir,
      totalFiles: files.length,
      pluralityCommunity: pluralityComm,
      pluralityCount,
      purity,
    });

    // Split candidate: directory spanning ≥2 communities with ≥COMMUNITY_MIN_FILES each
    const significantComms: Array<{ comm: number; count: number }> = [];
    for (const [comm, count] of commCounts) {
      if (count >= COMMUNITY_MIN_FILES && comm !== pluralityComm) {
        significantComms.push({ comm, count });
      }
    }
    if (significantComms.length >= 1 && pluralityCount >= COMMUNITY_MIN_FILES) {
      splitCandidates.push({
        directory: dir,
        communities: [pluralityComm, ...significantComms.map(s => s.comm)],
        fileCounts: [pluralityCount, ...significantComms.map(s => s.count)],
      });
    }
  }

  // Merge candidates: one community dominating ≥2 directories
  const commToDirs = new Map<number, Array<{ dir: string; count: number }>>();
  for (const dp of directoryPurities) {
    const comm = dp.pluralityCommunity;
    if (!commToDirs.has(comm)) commToDirs.set(comm, []);
    commToDirs.get(comm)!.push({ dir: dp.directory, count: dp.pluralityCount });
  }

  for (const [, entries] of commToDirs) {
    if (entries.length >= 2) {
      const dirs = entries.map(e => e.dir);
      const maxCount = Math.max(...entries.map(e => e.count));
      mergeCandidates.push({
        directories: dirs,
        community: directoryPurities.find(dp => dp.directory === dirs[0])!.pluralityCommunity,
        fileCount: maxCount,
      });
    }
  }

  // Agreement score: mean purity weighted by directory file count
  let totalWeightedPurity = 0;
  let totalFiles = 0;
  for (const dp of directoryPurities) {
    totalWeightedPurity += dp.purity * dp.totalFiles;
    totalFiles += dp.totalFiles;
  }
  const agreementScore = totalFiles > 0 ? totalWeightedPurity / totalFiles : 0;

  return { directoryPurities, splitCandidates, mergeCandidates, agreementScore };
}

function dirname(fp: string): string {
  const parts = fp.replace(/\\/g, '/').split('/');
  parts.pop();
  return parts.join('/');
}

// ── R4 — Martin instability & abstractness metrics ──────────────────────

/**
 * Compute Martin metrics per directory (treated as package).
 *
 * Ce = efferent couplings: distinct directories this directory imports from
 * Ca = afferent couplings: distinct directories that import this directory
 * I  = Ce / (Ca + Ce) — instability (0 if both zero)
 * A  = abstractness: exported type/interface declarations ÷ total exported symbols
 * D  = |A + I − 1| — distance from main sequence
 *
 * IMPORTANT: Abstractness computation uses an AST scan for export type/interface
 * declarations because the `functions` table does not index type/interface entities.
 * Uses a lightweight file-content scan.
 */
export function computeMartinMetrics(
  db: Database.Database,
  importGraph: ImportGraph
): MartinEntry[] {
  // Collect all directories from filePaths
  const dirSet = new Set<string>();
  for (const fp of importGraph.filePaths) {
    dirSet.add(dirname(fp));
  }
  const directories = [...dirSet];

  // Build directory-level adjacency: dir → Set<imported dir>
  const dirImports = new Map<string, Set<string>>();
  for (const [srcFile, neighbors] of importGraph.adjacency) {
    const srcDir = dirname(srcFile);
    if (!dirImports.has(srcDir)) dirImports.set(srcDir, new Set());

    for (const dstFile of neighbors.keys()) {
      const dstDir = dirname(dstFile);
      if (dstDir !== srcDir) {
        dirImports.get(srcDir)!.add(dstDir);
      }
    }
  }

  // Compute Ca (reverse: who imports each directory)
  const dirImportedBy = new Map<string, Set<string>>();
  for (const [srcDir, importedDirs] of dirImports) {
    for (const dstDir of importedDirs) {
      if (!dirImportedBy.has(dstDir)) dirImportedBy.set(dstDir, new Set());
      dirImportedBy.get(dstDir)!.add(srcDir);
    }
  }

  // Count exported symbols per directory: total exported functions + type/interface declarations
  // For abstractness: count type/interface declarations from file-content scan
  const dirExported = new Map<string, number>();
  const dirAbstract = new Map<string, number>();

  // Get all exported function counts from DB
  const exportedRows = db.prepare(
    'SELECT file_path, COUNT(*) as cnt FROM functions WHERE is_exported = 1 GROUP BY file_path'
  ).all() as Array<{ file_path: string; cnt: number }>;

  for (const row of exportedRows) {
    const dir = dirname(row.file_path);
    dirExported.set(dir, (dirExported.get(dir) ?? 0) + row.cnt);
  }

  // Scan for exported type/interface declarations per directory
  // This is a lightweight content-based scan since entity_type doesn't include type/interface
  const filePaths = [...importGraph.filePaths];
  const filesPerDir = new Map<string, string[]>();
  for (const fp of filePaths) {
    const dir = dirname(fp);
    if (!filesPerDir.has(dir)) filesPerDir.set(dir, []);
    filesPerDir.get(dir)!.push(fp);
  }

  for (const [dir, files] of filesPerDir) {
    let abstractCount = 0;
    for (const fp of files) {
      try {
        const content = require('fs').readFileSync(fp, 'utf-8');
        // Count exported type/interface declarations
        const typeMatches = content.match(/export\s+(type|interface)\s+\w+/g);
        if (typeMatches) {
          abstractCount += typeMatches.length;
        }
      } catch {
        // Skip unreadable files
      }
    }
    dirAbstract.set(dir, abstractCount);
  }

  // Build Martin entries
  const entries: MartinEntry[] = [];

  for (const dir of directories) {
    const imports = dirImports.get(dir);
    const importedBy = dirImportedBy.get(dir);

    const ce = imports?.size ?? 0;
    const ca = importedBy?.size ?? 0;
    const i = ca + ce > 0 ? ce / (ca + ce) : 0;

    const totalExported = dirExported.get(dir) ?? 0;
    const abstractCount = dirAbstract.get(dir) ?? 0;

    // A = exported abstract entities / total exported symbols
    const a = totalExported + abstractCount > 0
      ? abstractCount / (totalExported + abstractCount)
      : 0;

    const d = Math.abs(a + i - 1);

    entries.push({
      directory: dir,
      ce,
      ca,
      instability: i,
      abstractness: a,
      distanceFromMain: d,
    });
  }

  // Sort by distance from main sequence descending
  entries.sort((a, b) => b.distanceFromMain - a.distanceFromMain);

  return entries;
}

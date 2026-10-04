/**
 * Manifest staleness — the ecosystem-list self-check (Part 2b).
 *
 * The package manifest does not participate in classification. It is a staleness
 * report — "our list names drizzle-orm, this project doesn't depend on it" —
 * emitted as a diagnostic and affecting no verdict. A receiver classifies as a
 * DB handle by declaration resolution and SQL-argument evidence, never by
 * whether the project's package.json names the package.
 *
 * "Our list" is the TS implementation's `DB_PACKAGES` (tsEcosystem.ts, npm
 * packages) and the Go implementation's `GO_DB_PACKAGES` (goResolution.ts, Go
 * import paths). "This project depends on" is the union of package.json
 * `dependencies`/`devDependencies`/`peerDependencies` (TS) and go.mod `require`
 * lines (Go). The gap — a name our list carries that the project does not
 * actually depend on — is the only per-project signal that a hardcoded ecosystem
 * list has drifted from the ecosystem it claims to describe.
 *
 * This module reads the two manifests but owns nothing in them: `DB_PACKAGES` /
 * `GO_DB_PACKAGES` stay behind their implementations' interfaces, read here only
 * because this module *is* part of the resolution layer that owns them. Callers
 * above the interface surface the resulting {@link ManifestStaleEntry} list, not
 * the sets.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DB_PACKAGES } from './tsEcosystem.js';
import { GO_DB_PACKAGES } from '../languages/go/goResolution.js';

/** One stale entry: a package our ecosystem list names that the project doesn't. */
export interface ManifestStaleEntry {
  ecosystem: 'ts' | 'go';
  /** The package name (TS) or import path (Go) our list carries. */
  package: string;
  /** Absolute path to the manifest the comparison was made against. */
  manifestPath: string;
}

/** The project's declared dependency names, plus where they were read from. */
export interface ProjectManifest {
  /** Union of package.json dependencies + go.mod requires. */
  names: ReadonlySet<string>;
  /** Absolute path to package.json, or null when absent/unreadable. */
  tsManifestPath: string | null;
  /** Absolute path to go.mod, or null when absent/unreadable. */
  goManifestPath: string | null;
}

/**
 * Read the project's dependency names from package.json (TS) and go.mod (Go).
 * A missing or unreadable manifest contributes nothing — an empty manifest means
 * "no manifest to compare against", which produces no staleness (see
 * {@link computeManifestStaleness}).
 *
 * @param projectRoot — the project root containing package.json and/or go.mod.
 * @returns the union of declared dependency names plus the path to each manifest
 *          actually read (`null` when absent/unreadable).
 */
export async function readProjectManifest(projectRoot: string): Promise<ProjectManifest> {
  const names = new Set<string>();
  let tsManifestPath: string | null = null;
  let goManifestPath: string | null = null;

  const packageJsonPath = path.join(projectRoot, 'package.json');
  try {
    const raw = await readFile(packageJsonPath, 'utf-8');
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
      peerDependencies?: Record<string, unknown>;
    };
    for (const group of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
      for (const name of Object.keys(group ?? {})) names.add(name);
    }
    tsManifestPath = packageJsonPath;
  } catch {
    // no package.json (or unreadable) — nothing to compare the TS list against
  }

  const goModPath = path.join(projectRoot, 'go.mod');
  try {
    const raw = await readFile(goModPath, 'utf-8');
    let inRequireBlock = false;
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t.startsWith('require (')) {
        inRequireBlock = true;
        continue;
      }
      if (inRequireBlock) {
        if (t === ')') {
          inRequireBlock = false;
          continue;
        }
        const mod = t.split(/\s+/)[0];
        if (mod) names.add(mod);
        continue;
      }
      if (t.startsWith('require ')) {
        const mod = t.slice('require '.length).trim().split(/\s+/)[0];
        if (mod) names.add(mod);
      }
    }
    goManifestPath = goModPath;
  } catch {
    // no go.mod (or unreadable) — nothing to compare the Go list against
  }

  return { names, tsManifestPath, goManifestPath };
}

/**
 * The gap between our ecosystem lists and the project's manifest: every package
 * `DB_PACKAGES` / `GO_DB_PACKAGES` names that the project does not depend on.
 * Emitted only when the corresponding manifest exists — an absent package.json
 * produces no TS staleness (there is nothing to be stale against), and likewise
 * for go.mod and the Go list. Affects no verdict.
 *
 * @param manifest — the project's declared names and manifest paths.
 * @returns the stale entries: every ecosystem-list package the project does not
 *          depend on, restricted to manifests that actually exist.
 */
export function computeManifestStaleness(manifest: ProjectManifest): ManifestStaleEntry[] {
  const stale: ManifestStaleEntry[] = [];
  if (manifest.tsManifestPath !== null) {
    for (const pkg of DB_PACKAGES) {
      if (!manifest.names.has(pkg)) stale.push({ ecosystem: 'ts', package: pkg, manifestPath: manifest.tsManifestPath });
    }
  }
  if (manifest.goManifestPath !== null) {
    for (const pkg of GO_DB_PACKAGES) {
      if (!manifest.names.has(pkg)) stale.push({ ecosystem: 'go', package: pkg, manifestPath: manifest.goManifestPath });
    }
  }
  return stale;
}

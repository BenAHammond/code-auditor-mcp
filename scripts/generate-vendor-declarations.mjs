#!/usr/bin/env node
/**
 * Generate the vendor-declaration snapshot
 * (`src/analyzers/universal/vendor-declarations.json`) by reading each vendor's
 * *shipped* TypeScript declarations — never from a hand-maintained list.
 *
 * Item B: `UniversalDataAccessAnalyzer.ts` hand-maintains a set of method-name
 * lists (Kysely table/join verbs, SQLite/D1 eager methods, …). Those names are
 * published by the vendor in its `.d.ts`; a hand-written replica drifts when the
 * vendor adds, renames, or removes a method (the `.get()` gap fixed in #329, the
 * `.iterate()` deferral, and the current `join`-is-not-a-Kysely-verb mismatch are
 * all this class). This generator reads the real declaration surface so the
 * snapshot is reproducible and auditable, and the analyzer derives its sets from
 * the snapshot instead of copying names.
 *
 * Sources:
 *   - `better-sqlite3` — the installed `@types/better-sqlite3` (devDependency).
 *   - `node:sqlite`     — `@types/node`'s `sqlite.d.ts` (devDependency).
 *   - `kysely`          — fetched via `npm pack` (pinned, see VERSIONS).
 *   - `@cloudflare/workers-types` — fetched via `npm pack` (pinned).
 *
 * The fetched tarballs are unpacked into a throwaway temp dir under os.tmpdir()
 * and deleted after extraction. `npm pack` is a read-only registry fetch — it is
 * NOT a publish, dist-tag, login, or adduser, and it never writes into a corpus.
 *
 * Regenerate with:
 *   node scripts/generate-vendor-declarations.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, '..');
const outPath = join(appRoot, 'src', 'analyzers', 'universal', 'vendor-declarations.json');

// Pinned fetch versions — a reproducible snapshot needs reproducible inputs.
const VERSIONS = {
  kysely: '0.27.4',
  '@cloudflare/workers-types': '4.20240903.0',
};

/** Recursively collect every `.d.ts` under `dir` (skipping node_modules). */
function walkDts(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkDts(p, out);
    else if (p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * Read the method-name surface of a set of named interface/class declarations
 * from a list of `.d.ts` files. Method and property signatures both count — a
 * vendor may declare `all(...)` as a method or as a `(...args) => Result`
 * property, and both are part of the callable surface the analyzer must know.
 * `[Symbol.dispose]` and other non-identifier members are dropped.
 */
function methodSurface(dts, names) {
  const program = ts.createProgram(dts, {});
  const out = {};
  for (const sf of program.getSourceFiles()) {
    ts.forEachChild(sf, function walk(n) {
      const isDecl = ts.isInterfaceDeclaration(n) || ts.isClassDeclaration(n);
      if (isDecl && n.name && names.has(n.name.text)) {
        const ms = new Set();
        for (const m of n.members) {
          if (ts.isMethodSignature(m) || ts.isMethodDeclaration(m)
            || ts.isPropertySignature(m) || ts.isPropertyDeclaration(m)) {
            const nm = m.name && ts.isIdentifier(m.name) ? m.name.text
              : (m.name && m.name.getText ? m.name.getText(sf) : null);
            if (nm) ms.add(nm);
          }
        }
        out[n.name.text] = [...ms].sort();
      }
      ts.forEachChild(n, walk);
    });
  }
  return out;
}

/** `npm pack` a package into a throwaway dir and return its extracted root. */
function fetchPkg(name, version) {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-decl-'));
  const tgz = execFileSync('npm', ['pack', `${name}@${version}`, '--silent'], {
    cwd: dir, encoding: 'utf8',
  }).trim().split('\n').pop();
  execFileSync('tar', ['xzf', join(dir, tgz), '-C', dir]);
  rmSync(join(dir, tgz), { force: true });
  return join(dir, 'package');
}

function installedVersion(pkgJson) {
  try {
    return JSON.parse(readFileSync(pkgJson, 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

const vendors = {};

// 1. Local, already-installed devDependencies (no fetch).
const bs3Root = join(appRoot, 'node_modules', '@types', 'better-sqlite3');
const bs3 = methodSurface([join(bs3Root, 'index.d.ts')], new Set(['Database', 'Statement']));
vendors['better-sqlite3'] = {
  version: installedVersion(join(bs3Root, 'package.json')),
  source: '@types/better-sqlite3 (installed devDependency)',
  types: { Database: bs3.Database, Statement: bs3.Statement },
};

const nodeTypes = join(appRoot, 'node_modules', '@types', 'node');
const nsql = methodSurface([join(nodeTypes, 'sqlite.d.ts')], new Set(['DatabaseSync', 'StatementSync']));
vendors['node:sqlite'] = {
  version: installedVersion(join(nodeTypes, 'package.json')),
  source: '@types/node sqlite.d.ts (installed devDependency)',
  types: { DatabaseSync: nsql.DatabaseSync, StatementSync: nsql.StatementSync },
};

// 2. Fetched packages (read-only registry fetch, unpacked + deleted).
const tmpDirs = [];
try {
  const kyselyRoot = fetchPkg('kysely', VERSIONS.kysely);
  tmpDirs.push(kyselyRoot);
  const kyselyDts = walkDts(join(kyselyRoot, 'dist', 'esm'));
  const kysely = methodSurface(kyselyDts, new Set(['QueryCreator', 'SelectQueryBuilder']));
  vendors['kysely'] = {
    version: VERSIONS.kysely,
    source: 'npm kysely (fetched via npm pack)',
    types: { QueryCreator: kysely.QueryCreator, SelectQueryBuilder: kysely.SelectQueryBuilder },
  };

  const workersRoot = fetchPkg('@cloudflare/workers-types', VERSIONS['@cloudflare/workers-types']);
  tmpDirs.push(workersRoot);
  const workers = methodSurface([join(workersRoot, 'index.d.ts')], new Set(['D1Database', 'D1PreparedStatement']));
  vendors['@cloudflare/workers-types'] = {
    version: VERSIONS['@cloudflare/workers-types'],
    source: 'npm @cloudflare/workers-types (fetched via npm pack)',
    types: { D1Database: workers.D1Database, D1PreparedStatement: workers.D1PreparedStatement },
  };
} finally {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
}

const manifest = {
  // The analyzer derives its data-access method sets from these surfaces; the
  // *selection* of which names are table verbs / join verbs / eager I/O is a
  // documented judgment (specs/vendor-replica-probes.md). This file records only
  // what the vendor publishes, so the selection can be audited against it.
  generator: 'scripts/generate-vendor-declarations.mjs',
  vendors,
};

writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
const typeCount = Object.values(vendors)
  .flatMap((v) => Object.values(v.types))
  .reduce((n, m) => n + m.length, 0);
process.stdout.write(`generate-vendor-declarations → ${Object.keys(vendors).length} vendors, ${typeCount} method names\n`);

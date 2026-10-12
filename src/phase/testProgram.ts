/**
 * Test-program resolution — derives "is this file a test file" from the tree's
 * *declared* test runner, not a hardcoded path-substring list.
 *
 * The legacy `UniversalSecretsAnalyzer.isTestOrFixtureFile` answered the question
 * with a path heuristic — `.test.`/`.spec.`/`__tests__`/`/test/`/`/fixtures/` —
 * that described *shapes*, not *role*. A file named `latest.ts` in a `test/`
 * directory and a file named `contest.test.ts` in `src/` were both swept by a
 * string match, regardless of whether the project's test runner would ever
 * execute them. The directive item 2 asks: can a file's test role be derived
 * from the tree itself — the test runner declared in `package.json` `scripts`,
 * the runner's include globs (vitest.config/jest.config/mocha `spec`), or
 * test-program membership — rather than a path pattern?
 *
 * The answer, for every pinned corpus that carries a `hardcoded-secret` finding,
 * is yes, through the runner's own documented discovery convention:
 *
 *   - **deno** (`deno test`) — discovery is by *filename convention*: files
 *     named `{*_,*.,}test.{ts,tsx,js,jsx,mts,mjs}` and `__tests__/` directories.
 *     Deno has no per-file config list; its default is the source of truth.
 *   - **mocha** (`mocha --config <path>`) — the test program is the directory the
 *     config names (`<config>`'s parent, conventionally `test/`), plus the same
 *     home for its sibling runners (`tape`, `jake`) whose entry points live under
 *     the same directory.
 *   - **vitest / jest / node:test** — their *default* discovery conventions
 *     (`*.{test,spec}.*`, `__tests__/`, `*.test.*`). A config `include`/`testMatch`
 *     would override these; reading an arbitrary JS config module is not done
 *     here — the default is the source of truth, and a corpus whose runner
 *     overrides the default is reported as using the default, not silently.
 *
 * A monorepo's root `scripts.test` is often a task orchestrator (`turbo run test`,
 * `nx test`, `pnpm -r test`) rather than a runner. When that is detected — or
 * when the root declares no runner at all — the resolver reads the workspace
 * `package.json` manifests (bounded depth, `node_modules`/build dirs skipped) and
 * detects the runner each declares, exactly as the orchestrator would invoke it.
 *
 * When no runner is declared anywhere in the tree, the resolver falls back to
 * the shared path heuristic {@link isTestOrSpecPath} and reports that as its
 * source — the caller can then say "this corpus declares no test runner; the
 * path shape is the value used instead".
 */

import fs from 'node:fs';
import path from 'node:path';
import { isTestOrSpecPath } from '../languages/testConventions.js';

/** A resolved test program: a predicate over a file path plus the named source. */
export interface TestProgram {
  /** Human-readable source of truth for the decision, for reporting. */
  readonly source: string;
  /** True when `filePath` is a test file under the tree's declared runner. */
  isTestFile(filePath: string): boolean;
}

type Classifier = (relPath: string) => boolean;

const toPosix = (p: string): string => p.replace(/\\/g, '/');

/** Normalize a project-relative path's directory to a posix, slash-terminated form. */
function posixDir(p: string): string {
  const d = toPosix(path.posix.dirname(toPosix(p))).replace(/\/+$/, '');
  return d === '.' ? '' : d;
}

/** Deno default discovery: `{*_,*.,}test.{ts,tsx,js,jsx,mts,mjs}` + `__tests__/`. */
const DENO_EXT = '(ts|tsx|js|jsx|mts|mjs)';
const DENO_TEST_FILE = new RegExp(`[._]test\\.${DENO_EXT}$`);
const DENO_BARE_TEST_FILE = new RegExp(`/test\\.${DENO_EXT}$`);

function denoClassifier(): Classifier {
  return (rel) => DENO_TEST_FILE.test(rel) || DENO_BARE_TEST_FILE.test(rel) || /(^|\/)__tests__\//.test(rel);
}

/** vitest/jest default discovery: `*.{test,spec}.*` and `__tests__/`. */
function testSpecClassifier(): Classifier {
  return (rel) => /\.(test|spec)\.[^.]+$/.test(rel) || /(^|\/)__tests__\//.test(rel);
}

/** node:test default discovery: `*.test.{js,mjs,cjs,ts}` (and `__tests__/`). */
function nodeTestClassifier(): Classifier {
  return (rel) => /\.test\.(js|mjs|cjs|ts|tsx|jsx)$/.test(rel) || /(^|\/)__tests__\//.test(rel);
}

/** mocha/tape/jake: the test program is the directory the entry points name
 *  (the `--config <path>` / `node <path>` / `jake -f <path>` parent), falling
 *  back to the conventional `test/` home. */
function directoryHomeClassifier(scripts: string[]): Classifier {
  const homes = new Set<string>();
  for (const s of scripts) {
    const config = s.match(/--config\s+(\S+)/);
    if (config) homes.add(posixDir(config[1]));
    const nodeEntry = s.match(/(?:^|\s)node\s+(\S+?)\/\S*\.(?:js|mjs|cjs|ts)(?:\s|$|\|)/);
    if (nodeEntry) homes.add(posixDir(nodeEntry[1]));
    const jakeEntry = s.match(/(?:^|\s)jake\s+(?:-[a-z]\s+)*(\S+?)\/Jakefile/);
    if (jakeEntry) homes.add(posixDir(jakeEntry[1]));
  }
  if (homes.size === 0) homes.add('test');
  return (rel) => {
    const p = toPosix(rel);
    for (const h of homes) if (h !== '' && (p === h || p.startsWith(h + '/'))) return true;
    return false;
  };
}

// ── Runner detection ────────────────────────────────────────────────────────

type Runner = 'deno' | 'vitest' | 'jest' | 'mocha' | 'node:test' | 'tape' | 'jake' | 'orchestrator';

/** Detect a single runner token from one script string, or `orchestrator` /
 *  `null` when the script is a task fan-out / declares nothing. */
function detectRunner(script: string): Runner | null {
  if (/\bdeno\s+test\b/.test(script)) return 'deno';
  if (/\bvitest\b/.test(script)) return 'vitest';
  if (/\bjest\b/.test(script)) return 'jest';
  if (/\bmocha\b/.test(script)) return 'mocha';
  if (/node\s+--test\b|\bnode:test\b|--test-name-pattern/.test(script)) return 'node:test';
  if (/(?:^|\s)node\s+\S*\/?test\/tape\b/.test(script)) return 'tape';
  if (/\bjake\b/.test(script)) return 'jake';
  if (/\b(turbo|lerna)\b|\bnx\s+(run|test)\b|pnpm\s+(-r|--recursive|recursive)\b|yarn\s+workspaces?\b/.test(script)) {
    return 'orchestrator';
  }
  return null;
}

/** The classification order matters: a directory-home runner (mocha) subsumes
 *  its sibling runners, and a naming-convention runner (deno) is more precise
 *  than the shared test/spec path heuristic. */
const RUNNER_PRIORITY: Runner[] = ['mocha', 'tape', 'jake', 'deno', 'vitest', 'jest', 'node:test'];

function classifierFor(runner: Runner, scripts: string[]): Classifier | null {
  switch (runner) {
    case 'mocha':
    case 'tape':
    case 'jake':
      return directoryHomeClassifier(scripts);
    case 'deno':
      return denoClassifier();
    case 'vitest':
    case 'jest':
      return testSpecClassifier();
    case 'node:test':
      return nodeTestClassifier();
    default:
      return null;
  }
}

/** Read a `package.json`'s script values (all of them, not just `test` — a
 *  `test:unit`/`test:tape` script names the same runner). */
function scriptsFrom(dir: string): string[] {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return Object.values(pkg.scripts ?? {}).map(String);
  } catch {
    return [];
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'coverage', '.cache', 'out', 'vendor', '.venv']);

/** Bounded recursive collection of every nested `package.json`'s script values,
 *  used to reach a monorepo's workspace manifests when the root declares an
 *  orchestrator or no runner. */
function collectWorkspaceScripts(root: string, maxDepth: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name), depth + 1);
      } else if (e.name === 'package.json') {
        out.push(...scriptsFrom(dir));
      }
    }
  };
  walk(root, 0);
  return out;
}

/** The fallback program, used when the tree declares no test runner. Its source
 *  is the shared path heuristic — reported, not silently chosen. */
const FALLBACK: TestProgram = {
  source: 'path-heuristic (no test runner declared in package.json scripts)',
  isTestFile: (filePath) => isTestOrSpecPath(filePath),
};

const cache = new Map<string, TestProgram>();

function buildTestProgram(projectRoot: string): TestProgram {
  const rootScripts = scriptsFrom(projectRoot);
  const detected = new Set<Runner>();
  for (const s of rootScripts) {
    const r = detectRunner(s);
    if (r) detected.add(r);
  }

  // A root orchestrator (or a root that names no runner) defers to the workspace
  // manifests the orchestrator would invoke. The walk runs once and its scripts
  // are reused for the classifier below.
  let workspaceScripts: string[] = [];
  if (detected.size === 0 || detected.has('orchestrator')) {
    detected.delete('orchestrator');
    workspaceScripts = collectWorkspaceScripts(projectRoot, 6);
    for (const s of workspaceScripts) {
      const r = detectRunner(s);
      if (r && r !== 'orchestrator') detected.add(r);
    }
  }

  const runners: Runner[] = [...detected].filter((r) => r !== 'orchestrator');
  if (runners.length === 0) return FALLBACK;

  const allScripts = [...rootScripts, ...workspaceScripts];
  const ordered = RUNNER_PRIORITY.filter((r) => runners.includes(r));
  const classifiers = ordered.map((r) => classifierFor(r, allScripts)).filter((c): c is Classifier => !!c);
  const source = ordered.join('+');

  return {
    source,
    isTestFile: (filePath) => {
      const rel = relativize(projectRoot, filePath);
      return classifiers.some((c) => c(rel));
    },
  };
}

/** Project-root-relative posix path, or the path as-given when outside the root. */
function relativize(projectRoot: string, filePath: string): string {
  const p = toPosix(filePath);
  const root = toPosix(projectRoot).replace(/\/+$/, '');
  if (root && (p === root || p.startsWith(root + '/'))) return p.slice(root.length + 1);
  return p;
}

/** Resolve the tree's declared test program for `projectRoot` (cached). A
 *  missing root yields the path-heuristic fallback (slice/unit-test shorthand). */
export function resolveTestProgram(projectRoot: string | undefined): TestProgram {
  if (!projectRoot) return FALLBACK;
  const cached = cache.get(projectRoot);
  if (cached) return cached;
  const program = buildTestProgram(projectRoot);
  cache.set(projectRoot, program);
  return program;
}

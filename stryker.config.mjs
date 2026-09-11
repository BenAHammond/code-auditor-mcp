// Stryker mutation testing config — Spec 53 R1.
//
// Scoped to the analyzers and the extraction layer (src/analyzers, src/languages,
// src/graph, src/styles) per the spec. CLI, daemon, and reporting are out of
// scope (different failure modes; mutating everything is cost-prohibitive).
//
// The deliverable is the *surviving-mutant list*, not a score — so `thresholds`
// is disabled (`break: null`) and the JSON reporter is on so the list can be
// parsed out of reports/mutation/mutation.json.
//
// Pinned to Stryker 8.7.1: Stryker 10's vitest-runner requires vitest >=2, and
// this project is on vitest 1.6.1.

// pnpm keeps the vitest runner in an isolated `.pnpm` store, so Stryker's
// `@stryker-mutator/*` glob (which resolves relative to @stryker-mutator/core's
// own node_modules) never sees it. Resolve the entry explicitly and hand Stryker
// a file:// URL instead of relying on plugin auto-discovery.
const vitestRunnerPlugin = import.meta.resolve('@stryker-mutator/vitest-runner');

/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  packageManager: 'pnpm',
  testRunner: 'vitest',
  coverageAnalysis: 'perTest',
  plugins: [vitestRunnerPlugin],

  // typescript@7 (the native Go compiler) exposes no JS API — Stryker's
  // ts-config-preprocessor calls `ts.parseConfigFileTextToJson`, which does not
  // exist. `inPlace: true` makes Stryker skip that rewrite entirely (it only
  // exists to fix `extends`/`references` paths inside the sandbox copy, and this
  // tsconfig has neither). Files are mutated in place and restored from a backup
  // in `.stryker-tmp` on completion.
  inPlace: true,

  // The four scoped directories, minus test/fixture files.
  mutate: [
    'src/analyzers/**/*.ts',
    'src/languages/**/*.ts',
    'src/graph/**/*.ts',
    'src/styles/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/**/*.test.ts',
    '!src/**/__tests__/**',
    '!src/**/fixtures/**',
  ],

  reporters: ['clear-text', 'html', 'json'],

  // Never break the run on a low score — we want the full survivor list.
  thresholds: { high: 100, low: 100, break: null },

  ignoreStatic: true,
  timeoutMS: 120000,
  concurrency: 8,
  cleanTempDir: false,
  tempDirName: '.stryker-tmp',
};

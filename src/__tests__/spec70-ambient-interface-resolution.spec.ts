/**
 * Spec 70 criterion 9 (Item 4) — cross-file global-script `interface Env` resolution.
 *
 * A Workers handler declares `env: Env` where `interface Env { DB: D1Database }`
 * lives in a *sibling* `worker-configuration.d.ts` (wrangler-generated: no top-level
 * import/export, so a TypeScript *global script*, not a module). `interfaceFields`
 * is per-file only, so the handler's own extract never sees `Env` and the
 * declaration-resolution source of `identifyHandle` would leave `env.DB.prepare(…)`
 * `unproven` — a false "cannot-fire" surface. The corpus-wide ambient interface map
 * (`computeAmbientInterfaceFields`, merged under each file's local fields in
 * `fileReceiverEnv`) closes that gap: it aggregates global-script interfaces once and
 * lets a handler resolve `Env` from the sibling `.d.ts`.
 *
 * The guarantee pinned here is the exact shape the defect report named: a template
 * literal SQL argument that the dialect *cannot parse* must not prevent
 * declaration-resolution from proving the receiver. The SQL half failing is expected;
 * the declaration-resolution half not covering for it is the defect.
 *
 * Two layers:
 *   1. `computeAmbientInterfaceFields` — aggregates only global-script interfaces,
 *      excluding any file that is a module (appears in import/export facts).
 *   2. The full corpus pipeline — `runPhaseModelOverFiles` over both files leaves
 *      `unprovenQueryReceivers` empty, and leaves it non-empty when the global
 *      script is absent (the negative control proving the map is the mechanism).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { runPhaseModelOverFiles } from '../phase/phaseModel.js';
import { computeAmbientInterfaceFields } from '../phase/receiverProvenance.js';
import { readDeclaredTypePackages } from '../graph/importClassification.js';
import type { WithinFileProvenanceFact, ImportSpecifiersFact, ExportSymbolFact } from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

/** The handler under test: `env: Env` + `env.DB.prepare(<template literal>)`.
 *  The template SQL uses `?` (a postgresql-invalid placeholder), so under
 *  `postgresql` the sql-argument source cannot parse it — the declaration-resolution
 *  source is the only path to `handle`. */
const HANDLER_SRC = [
  'export default {',
  '  async fetch(request: Request, env: Env) {',
  '    const stmt = env.DB.prepare(`SELECT * FROM users WHERE id = ?`);',
  '    await stmt.all();',
  '  },',
  '};',
].join('\n');

/** The wrangler-generated global script: `interface Env { DB: D1Database }`, no
 *  top-level import/export. */
const WORKER_CONFIG_DTS = ['interface Env {', '  DB: D1Database;', '}'].join('\n');

/** Build a throwaway Workers fixture: package.json declaring workers-types, the
 *  global-script `.d.ts`, and the handler. Returns the project root. */
function buildFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'code-auditor-ambient-'));
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', devDependencies: { '@cloudflare/workers-types': '4.20240101.0' } }),
  );
  writeFileSync(path.join(root, 'worker-configuration.d.ts'), WORKER_CONFIG_DTS);
  writeFileSync(path.join(root, 'handler.ts'), HANDLER_SRC);
  return root;
}

describe('Spec 70 criterion 9 — computeAmbientInterfaceFields', () => {
  it('aggregates a global-script interface and excludes module files', () => {
    const within: WithinFileProvenanceFact[] = [
      // A module file (exported) — its interface must NOT leak into the ambient map.
      {
        file: '/proj/handler.ts',
        format: 'typescript',
        ts: { interfaceFields: [{ name: 'Env', fields: [{ name: 'DB', typeText: 'D1Database' }] }] },
      } as unknown as WithinFileProvenanceFact,
      // A global-script file (no import/export) — its interface IS ambient.
      {
        file: '/proj/worker-configuration.d.ts',
        format: 'typescript',
        ts: { interfaceFields: [{ name: 'Env', fields: [{ name: 'DB', typeText: 'D1Database' }] }] },
      } as unknown as WithinFileProvenanceFact,
      // A Go file — skipped.
      {
        file: '/proj/main.go',
        format: 'go',
        ts: { interfaceFields: [] },
      } as unknown as WithinFileProvenanceFact,
    ];
    // The handler is a module (it exports), so it is in the export facts.
    const imports: ImportSpecifiersFact[] = [];
    const exports: ExportSymbolFact[] = [{ file: '/proj/handler.ts' } as unknown as ExportSymbolFact];

    const ambient = computeAmbientInterfaceFields(within, imports, exports);
    // Only the global-script `.d.ts` contributes `Env`; the module handler does not.
    expect(ambient.get('Env')).toEqual(new Map([['DB', 'D1Database']]));
    // The map has exactly one interface name (the handler's `Env` was excluded).
    expect([...ambient.keys()]).toEqual(['Env']);
  });

  it('is first-wins across the corpus for a name declared in multiple global scripts', () => {
    const within: WithinFileProvenanceFact[] = [
      {
        file: '/proj/a.d.ts',
        format: 'typescript',
        ts: { interfaceFields: [{ name: 'Env', fields: [{ name: 'A', typeText: 'string' }] }] },
      } as unknown as WithinFileProvenanceFact,
      {
        file: '/proj/b.d.ts',
        format: 'typescript',
        ts: { interfaceFields: [{ name: 'Env', fields: [{ name: 'B', typeText: 'string' }] }] },
      } as unknown as WithinFileProvenanceFact,
    ];
    const ambient = computeAmbientInterfaceFields(within, [], []);
    expect(ambient.get('Env')).toEqual(new Map([['A', 'string']]));
  });
});

describe('Spec 70 criterion 9 — corpus pipeline resolves a cross-file `Env`', () => {
  let root: string;
  let declaredTypePackages: ReadonlySet<string>;

  beforeAll(() => {
    root = buildFixture();
    declaredTypePackages = readDeclaredTypePackages(root);
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function run(handlerPath: string, handlerSrc: string, dtsPath?: string, dtsSrc?: string) {
    const inputs: Array<{ path: string; content: string }> = [{ path: handlerPath, content: handlerSrc }];
    if (dtsPath !== undefined && dtsSrc !== undefined) inputs.push({ path: dtsPath, content: dtsSrc });
    return runPhaseModelOverFiles(inputs, new Map(), {
      projectRoot: root,
      declaredTypePackages,
      sqlDialect: 'postgresql',
      corpusFiles: inputs.map((i) => i.path),
    });
  }

  it('resolves `env.DB.prepare(<unparseable template>)` to `handle` via the sibling `.d.ts`', async () => {
    const handlerPath = path.join(root, 'handler.ts');
    const dtsPath = path.join(root, 'worker-configuration.d.ts');
    const res = await run(handlerPath, HANDLER_SRC, dtsPath, WORKER_CONFIG_DTS);
    // The declaration-resolution source proves `env.DB` → `D1Database` → handle
    // even though the template SQL cannot be parsed under postgresql. No cannot-fire
    // site may survive…
    expect(res.unprovenQueryReceivers).toEqual([]);
    // …and the site IS a DB handle (not a non-DB receiver that happened to clear the
    // cannot-fire surface): it re-appears in the `unparseable` diagnostic, which is
    // only emitted for an admitted handle whose SQL the dialect cannot parse.
    expect(res.unparseableSql).toHaveLength(1);
    expect(res.unparseableSql[0].sqlText).toContain('SELECT * FROM users');
    expect(res.unparseableSql[0].file).toBe(handlerPath);
  });

  it('leaves the same site unproven when the global-script interface is absent (negative control)', async () => {
    const handlerPath = path.join(root, 'handler.ts');
    // Same handler, but `Env` is nowhere declared — the ambient map is empty and
    // the declaration-resolution source abstains, so the site is a genuine
    // cannot-fire. This proves the sibling `.d.ts` (not some other relaxation) is
    // what clears the surface.
    const res = await run(handlerPath, HANDLER_SRC);
    expect(res.unprovenQueryReceivers).toHaveLength(1);
    expect(res.unprovenQueryReceivers[0].receiver).toBe('env.DB');
  });
});

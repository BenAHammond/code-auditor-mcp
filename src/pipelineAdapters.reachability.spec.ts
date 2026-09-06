/**
 * dependency-graph reducer reachability tests (Spec — orphaned-nodes fix).
 *
 * Exercises three behaviors added to `createDependencyGraphReducer`:
 *   1. orphaned-nodes emit one violation per orphan, attributed to its own
 *      file/line (the previous form anchored every orphan to the first node).
 *   2. `unreferenced-module` flags a file that exports symbols yet is imported
 *      by nothing and is not a framework entry point.
 *   3. file reachability is persisted to graph_cache for the post-pipeline
 *      ranking axis.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDependencyGraphReducer } from './pipelineAdapters.js';
import { CodeIndexDB } from './codeIndexDB.js';
import type { CrossLanguageEntity } from './types/crossLanguage.js';

function entity(
  id: string,
  name: string,
  file: string,
  startLine: number,
  opts: Partial<CrossLanguageEntity> = {},
): CrossLanguageEntity {
  return {
    id,
    name,
    language: 'typescript',
    file,
    type: 'function',
    signature: `function ${name}() {}`,
    parameters: [],
    startLine,
    visibility: 'private',
    calls: [],
    calledBy: [],
    purpose: '',
    context: '',
    searchTokens: [name.toLowerCase()],
    ...opts,
  };
}

describe('createDependencyGraphReducer — orphan + reachability', () => {
  let db: CodeIndexDB;

  beforeEach(async () => {
    CodeIndexDB.resetInstance();
    db = CodeIndexDB.getInstance(':memory:');
    await db.initialize();
  });

  afterEach(() => {
    CodeIndexDB.resetInstance();
  });

  async function run(facts: Record<string, unknown>) {
    const reducer = createDependencyGraphReducer();
    const context: any = { isScoped: false, indexHandle: { rawDb: db.rawDb } };
    return reducer.reduce(facts, context);
  }

  it('attributes each orphan to its own file/line', async () => {
    const facts = {
      'cross-language-entities': {
        'src/dead.ts': {
          entities: [entity('d1', 'neverUsed', 'src/dead.ts', 10)],
          imports: [],
          hasExports: false,
        },
        'src/other.ts': {
          entities: [entity('d2', 'unusedHelper', 'src/other.ts', 25)],
          imports: [],
          hasExports: false,
        },
      },
    };

    const result = await run(facts);
    const orphans = result.violations.filter((v) => v.type === 'orphaned-nodes');
    expect(orphans).toHaveLength(2);

    const byName = new Map(orphans.map((v) => [v.functionName, v]));
    expect(byName.get('neverUsed')).toMatchObject({ file: 'src/dead.ts', line: 10 });
    expect(byName.get('unusedHelper')).toMatchObject({ file: 'src/other.ts', line: 25 });
  });

  it('flags an exported-but-unimported module as unreferenced-module', async () => {
    const facts = {
      'cross-language-entities': {
        'src/exportedDead.ts': {
          // exported → not an orphaned-node; but nothing imports the file.
          entities: [entity('e1', 'exportedDead', 'src/exportedDead.ts', 5, { visibility: 'public' })],
          imports: [],
          hasExports: true,
        },
      },
    };

    const result = await run(facts);
    expect(result.violations.filter((v) => v.type === 'orphaned-nodes')).toHaveLength(0);

    const unreferenced = result.violations.filter((v) => v.type === 'unreferenced-module');
    expect(unreferenced).toHaveLength(1);
    expect(unreferenced[0].file).toBe('src/exportedDead.ts');
  });

  it('does not flag an imported module or an entry-point file', async () => {
    const facts = {
      'cross-language-entities': {
        'src/util.ts': {
          entities: [entity('u1', 'sharedHelper', 'src/util.ts', 3, { visibility: 'public' })],
          imports: [],
          hasExports: true,
        },
        'src/consumer.ts': {
          entities: [entity('c1', 'consumer', 'src/consumer.ts', 3)],
          imports: ['./util'],
          hasExports: false,
        },
        'src/app/api/route.ts': {
          entities: [entity('r1', 'handler', 'src/app/api/route.ts', 3)],
          imports: [],
          hasExports: true,
        },
      },
    };

    const result = await run(facts);
    const unreferenced = result.violations.filter((v) => v.type === 'unreferenced-module');
    expect(unreferenced).toHaveLength(0);
  });

  it('resolves relative imports against absolute file paths (live modules are not flagged)', async () => {
    // Real audits discover files as absolute paths (findFiles → path.join of the
    // project root). A relative import (`./util`) must resolve to the sibling's
    // absolute path — otherwise every file that imports a sibling is wrongly
    // flagged unreferenced. This is the false-positive class the hhra-org run
    // surfaced (queue-worker/src/* all flagged despite importing each other).
    const abs = '/repo/src';
    const facts = {
      'cross-language-entities': {
        [`${abs}/util.ts`]: {
          entities: [entity('u1', 'sharedHelper', `${abs}/util.ts`, 3, { visibility: 'public' })],
          imports: [],
          hasExports: true,
        },
        [`${abs}/consumer.ts`]: {
          entities: [entity('c1', 'consumer', `${abs}/consumer.ts`, 3)],
          imports: ['./util'],
          hasExports: false,
        },
        [`${abs}/dead.ts`]: {
          entities: [entity('d1', 'dead', `${abs}/dead.ts`, 3, { visibility: 'public' })],
          imports: [],
          hasExports: true,
        },
      },
    };

    const result = await run(facts);
    const unreferenced = result.violations.filter((v) => v.type === 'unreferenced-module');
    const files = unreferenced.map((v) => v.file);

    expect(files).toContain(`${abs}/dead.ts`);
    expect(files).not.toContain(`${abs}/util.ts`); // imported via './util'
  });

  it('persists reachability to graph_cache', async () => {
    const facts = {
      'cross-language-entities': {
        'src/dead.ts': {
          entities: [entity('d1', 'neverUsed', 'src/dead.ts', 10)],
          imports: [],
          hasExports: false,
        },
        'src/app/api/route.ts': {
          entities: [entity('r1', 'handler', 'src/app/api/route.ts', 3)],
          imports: [],
          hasExports: true,
        },
      },
    };

    await run(facts);

    const rows = db.rawDb
      .prepare("SELECT node_key, weight FROM graph_cache WHERE graph_type = 'reachability'")
      .all() as Array<{ node_key: string; weight: number }>;
    const byFile = new Map(rows.map((r) => [r.node_key, r.weight]));
    expect(byFile.get('src/dead.ts')).toBe(0); // dead
    expect(byFile.get('src/app/api/route.ts')).toBe(1); // entry point
  });
});
